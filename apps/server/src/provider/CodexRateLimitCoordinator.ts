import type { ServerProviderRateLimits } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { type CodexRateLimitAccountKey, normalizeCodexRateLimits } from "./CodexRateLimits.ts";

const ACTIVE_REFRESH_INTERVAL = "30 seconds" as const;
const MAX_UNCHANGED_BROADCAST_INTERVAL_MS = 5 * 60_000;
const RECENT_SUCCESS_MS = 15_000;
const READ_TIMEOUT = "10 seconds" as const;

type RateLimitsReader = () => Effect.Effect<
  CodexRateLimitReadResult,
  CodexErrors.CodexAppServerError
>;

export interface CodexRateLimitReadResult {
  readonly accountKey: CodexRateLimitAccountKey | null;
  readonly rateLimits?: CodexSchema.V2GetAccountRateLimitsResponse;
}

export interface CodexRateLimitSnapshot {
  readonly accountKey: CodexRateLimitAccountKey;
  readonly rateLimits: ServerProviderRateLimits;
}

interface SessionReader {
  readonly read: RateLimitsReader;
  readonly activeTurnIds: ReadonlySet<string>;
}

interface CoordinatorState {
  readonly generation: number;
  readonly accountKey: CodexRateLimitAccountKey | null | undefined;
  readonly transitionSessionId: string | undefined;
  readonly current: CodexRateLimitSnapshot | undefined;
  readonly lastBroadcast: CodexRateLimitSnapshot | undefined;
  readonly lastSuccessAt: number | undefined;
  readonly successRevision: number;
  readonly sessions: ReadonlyMap<string, SessionReader>;
}

interface ReaderCandidate {
  readonly read: RateLimitsReader;
  readonly sessionId: string;
}

interface CommitResult {
  readonly committed: boolean;
  readonly publish: boolean;
}

export interface CodexRateLimitCoordinatorShape {
  readonly current: Effect.Effect<CodexRateLimitSnapshot | undefined>;
  readonly generation: Effect.Effect<number>;
  readonly changes: Stream.Stream<CodexRateLimitSnapshot | undefined>;
  readonly syncAccount: (
    accountKey: CodexRateLimitAccountKey | null,
    rateLimits?: ServerProviderRateLimits | undefined,
    expectedGeneration?: number | undefined,
  ) => Effect.Effect<void>;
  readonly registerSession: (sessionId: string, read: RateLimitsReader) => Effect.Effect<void>;
  readonly unregisterSession: (sessionId: string) => Effect.Effect<void>;
  readonly accountChanged: (sessionId: string) => Effect.Effect<void>;
  readonly turnStarted: (sessionId: string, turnId: string) => Effect.Effect<void>;
  readonly turnSettled: (sessionId: string, turnId: string) => Effect.Effect<void>;
  readonly invalidate: (sessionId: string) => Effect.Effect<void>;
}

export const makeCodexRateLimitCoordinator = Effect.fn("makeCodexRateLimitCoordinator")(
  function* (): Effect.fn.Return<CodexRateLimitCoordinatorShape, never, Scope.Scope> {
    const scope = yield* Effect.scope;
    const refreshSemaphore = yield* Semaphore.make(1);
    const stateRef = yield* Ref.make<CoordinatorState>({
      generation: 0,
      accountKey: undefined,
      transitionSessionId: undefined,
      current: undefined,
      lastBroadcast: undefined,
      lastSuccessAt: undefined,
      successRevision: 0,
      sessions: new Map(),
    });
    const changesPubSub = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);

    const publish = (changed: boolean) =>
      changed ? PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid) : Effect.void;

    const readersFor = (
      state: CoordinatorState,
      preferredSessionId?: string,
    ): ReadonlyArray<ReaderCandidate> => {
      const readers: ReaderCandidate[] = [];
      const seen = new Set<string>();
      const append = (sessionId: string | undefined) => {
        if (!sessionId || seen.has(sessionId)) return;
        const session = state.sessions.get(sessionId);
        if (!session) return;
        seen.add(sessionId);
        readers.push({ read: session.read, sessionId });
      };

      if (state.transitionSessionId) {
        append(state.transitionSessionId);
      } else {
        append(preferredSessionId);
        for (const [sessionId, session] of state.sessions) {
          if (session.activeTurnIds.size > 0) append(sessionId);
        }
        for (const sessionId of state.sessions.keys()) append(sessionId);
      }
      return readers;
    };

    const readCandidate = (reader: RateLimitsReader) =>
      reader().pipe(
        Effect.timeoutOption(READ_TIMEOUT),
        Effect.catch((cause) =>
          Effect.logDebug("Codex account rate-limit reader failed.", { cause }).pipe(
            Effect.as(Option.none<CodexRateLimitReadResult>()),
          ),
        ),
      );

    const commit = Effect.fn("CodexRateLimitCoordinator.commit")(function* (
      reader: ReaderCandidate,
      candidate: CodexRateLimitReadResult,
      expectedGeneration: number,
    ) {
      const fetchedAt = DateTime.formatIso(yield* DateTime.now);
      const normalized = candidate.rateLimits
        ? normalizeCodexRateLimits(candidate.rateLimits, fetchedAt)
        : undefined;
      const now = yield* Clock.currentTimeMillis;
      const result = yield* Ref.modify(
        stateRef,
        (state): readonly [CommitResult, CoordinatorState] => {
          const readerOwnsTransition = state.transitionSessionId === reader.sessionId;
          const accountMatches =
            state.accountKey === undefined || state.accountKey === candidate.accountKey;
          if (
            state.generation !== expectedGeneration ||
            !accountMatches ||
            (state.transitionSessionId && !readerOwnsTransition)
          ) {
            return [{ committed: false, publish: false }, state] as const;
          }

          const current =
            candidate.accountKey !== null && normalized
              ? { accountKey: candidate.accountKey, rateLimits: normalized }
              : undefined;
          const shouldPublish = shouldBroadcast(state.lastBroadcast, current);
          return [
            { committed: true, publish: shouldPublish },
            {
              ...state,
              accountKey: candidate.accountKey,
              transitionSessionId: undefined,
              current,
              lastBroadcast: shouldPublish ? current : state.lastBroadcast,
              lastSuccessAt: now,
              successRevision: state.successRevision + 1,
            },
          ] as const;
        },
      );
      yield* publish(result.publish);
      return result.committed;
    });

    const refresh = Effect.fn("CodexRateLimitCoordinator.refresh")(function* (input?: {
      readonly forceAfterRevision?: number | undefined;
      readonly sessionId?: string | undefined;
    }) {
      yield* refreshSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          const now = yield* Clock.currentTimeMillis;
          const alreadySatisfied =
            input?.forceAfterRevision !== undefined
              ? state.successRevision > input.forceAfterRevision
              : state.lastSuccessAt !== undefined && now - state.lastSuccessAt < RECENT_SUCCESS_MS;
          if (alreadySatisfied) return;

          for (const reader of readersFor(state, input?.sessionId)) {
            const candidate = yield* readCandidate(reader.read);
            if (
              Option.isSome(candidate) &&
              (yield* commit(reader, candidate.value, state.generation))
            ) {
              return;
            }
          }
        }),
      );
    });

    const requestForcedRefresh = Effect.fn("CodexRateLimitCoordinator.requestForcedRefresh")(
      function* (sessionId?: string) {
        const revision = (yield* Ref.get(stateRef)).successRevision;
        yield* refresh({ forceAfterRevision: revision, sessionId }).pipe(Effect.forkIn(scope));
      },
    );

    const updateTurn = (sessionId: string, turnId: string, active: boolean) =>
      Ref.update(stateRef, (state) => {
        const session = state.sessions.get(sessionId);
        if (!session) return state;
        const activeTurnIds = new Set(session.activeTurnIds);
        if (active) activeTurnIds.add(turnId);
        else activeTurnIds.delete(turnId);
        const sessions = new Map(state.sessions);
        sessions.set(sessionId, { ...session, activeTurnIds });
        return { ...state, sessions };
      });

    const hasActiveTurns = Ref.get(stateRef).pipe(
      Effect.map((state) =>
        Array.from(state.sessions.values()).some((session) => session.activeTurnIds.size > 0),
      ),
    );

    yield* Effect.forever(
      Effect.sleep(ACTIVE_REFRESH_INTERVAL).pipe(
        Effect.andThen(hasActiveTurns),
        Effect.flatMap((active) => (active ? refresh() : Effect.void)),
      ),
    ).pipe(Effect.forkIn(scope));
    return {
      current: Ref.get(stateRef).pipe(Effect.map((state) => state.current)),
      generation: Ref.get(stateRef).pipe(Effect.map((state) => state.generation)),
      changes: Stream.fromPubSub(changesPubSub).pipe(
        Stream.mapEffect(() => Ref.get(stateRef).pipe(Effect.map((state) => state.current))),
      ),
      syncAccount: (accountKey, rateLimits, expectedGeneration) =>
        Effect.gen(function* () {
          const result = yield* Ref.modify(stateRef, (state) => {
            if (expectedGeneration !== undefined && state.generation !== expectedGeneration) {
              return [{ publish: false }, state] as const;
            }
            const accountChanged =
              state.accountKey !== undefined && state.accountKey !== accountKey;
            const current =
              accountKey === null
                ? undefined
                : rateLimits
                  ? rateLimits.windows.length > 0
                    ? { accountKey, rateLimits }
                    : undefined
                  : accountChanged
                    ? undefined
                    : state.current;
            const shouldPublish = shouldBroadcast(state.lastBroadcast, current);
            return [
              {
                publish: shouldPublish,
              },
              {
                ...state,
                generation: accountChanged ? state.generation + 1 : state.generation,
                accountKey,
                transitionSessionId: undefined,
                current,
                lastBroadcast: shouldPublish ? current : state.lastBroadcast,
                lastSuccessAt: rateLimits
                  ? Date.parse(rateLimits.fetchedAt)
                  : accountChanged || accountKey === null
                    ? undefined
                    : state.lastSuccessAt,
                successRevision: rateLimits ? state.successRevision + 1 : state.successRevision,
              },
            ] as const;
          });
          yield* publish(result.publish);
        }),
      registerSession: (sessionId, read) =>
        Ref.update(stateRef, (state) => {
          const sessions = new Map(state.sessions);
          sessions.set(sessionId, {
            read,
            activeTurnIds: state.sessions.get(sessionId)?.activeTurnIds ?? new Set(),
          });
          return { ...state, sessions };
        }),
      unregisterSession: (sessionId) =>
        Ref.update(stateRef, (state) => {
          const sessions = new Map(state.sessions);
          sessions.delete(sessionId);
          return { ...state, sessions };
        }),
      accountChanged: (sessionId) =>
        Effect.gen(function* () {
          const result = yield* Ref.modify(stateRef, (state) => {
            const shouldPublish = state.lastBroadcast !== undefined;
            return [
              { publish: shouldPublish },
              {
                ...state,
                generation: state.generation + 1,
                accountKey: undefined,
                transitionSessionId: sessionId,
                current: undefined,
                lastBroadcast: shouldPublish ? undefined : state.lastBroadcast,
                lastSuccessAt: undefined,
              },
            ] as const;
          });
          yield* publish(result.publish);
          yield* requestForcedRefresh(sessionId);
        }),
      turnStarted: (sessionId, turnId) =>
        updateTurn(sessionId, turnId, true).pipe(
          Effect.andThen(refresh({ sessionId }).pipe(Effect.forkIn(scope))),
          Effect.asVoid,
        ),
      turnSettled: (sessionId, turnId) =>
        updateTurn(sessionId, turnId, false).pipe(Effect.andThen(requestForcedRefresh(sessionId))),
      invalidate: requestForcedRefresh,
    };
  },
);

function shouldBroadcast(
  previous: CodexRateLimitSnapshot | undefined,
  next: CodexRateLimitSnapshot | undefined,
): boolean {
  if (!previous || !next) return previous !== next;
  if (
    previous.accountKey !== next.accountKey ||
    previous.rateLimits.windows.length !== next.rateLimits.windows.length ||
    previous.rateLimits.windows.some((window, index) => {
      const nextWindow = next.rateLimits.windows[index];
      return (
        !nextWindow ||
        window.windowDurationMins !== nextWindow.windowDurationMins ||
        window.usedPercent !== nextWindow.usedPercent ||
        window.resetsAt !== nextWindow.resetsAt
      );
    })
  ) {
    return true;
  }
  return (
    Date.parse(next.rateLimits.fetchedAt) - Date.parse(previous.rateLimits.fetchedAt) >=
    MAX_UNCHANGED_BROADCAST_INTERVAL_MS
  );
}
