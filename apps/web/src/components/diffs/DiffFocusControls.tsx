import { FunnelIcon } from "lucide-react";

import type {
  DeferredDiffCategory,
  DiffFocusableTier,
  DiffFocusPreferences,
} from "~/lib/diffFileFocus";
import { cn } from "~/lib/utils";

import { DiffStatLabel } from "../chat/DiffStatLabel";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TIER_LABELS = { test: "Tests", generated: "Generated" } as const;

export function DiffFocusMenu(props: {
  readonly preferences: DiffFocusPreferences;
  readonly testFileCount: number;
  readonly generatedFileCount: number;
  readonly deferredFileCount: number;
  readonly onTierVisibilityChange: (tier: DiffFocusableTier, visible: boolean) => void;
}) {
  const hasFocusableFiles = props.testFileCount > 0 || props.generatedFileCount > 0;
  if (!hasFocusableFiles) return null;

  const label =
    props.deferredFileCount === 0
      ? "Review focus: all files shown"
      : `Review focus: ${props.deferredFileCount} ${props.deferredFileCount === 1 ? "file" : "files"} deferred`;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className={cn(props.deferredFileCount > 0 && "bg-accent text-accent-foreground")}
                  aria-label={label}
                />
              }
            />
          }
        >
          <FunnelIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Show in diff</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked disabled closeOnClick={false}>
          <span className="flex min-w-0 flex-1 justify-between gap-4">
            <span>Source</span>
            <span className="tabular-nums text-muted-foreground">Always</span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={props.preferences.showTests}
          closeOnClick={false}
          disabled={props.testFileCount === 0}
          onCheckedChange={(checked) => props.onTierVisibilityChange("test", checked)}
        >
          <span className="flex min-w-0 flex-1 justify-between gap-4">
            <span>Tests</span>
            <span className="tabular-nums text-muted-foreground">{props.testFileCount}</span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={props.preferences.showGenerated}
          closeOnClick={false}
          disabled={props.generatedFileCount === 0}
          onCheckedChange={(checked) => props.onTierVisibilityChange("generated", checked)}
        >
          <span className="flex min-w-0 flex-1 justify-between gap-4">
            <span>Generated</span>
            <span className="tabular-nums text-muted-foreground">{props.generatedFileCount}</span>
          </span>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DeferredDiffFiles(props: {
  readonly categories: ReadonlyArray<DeferredDiffCategory>;
  readonly incomplete?: boolean;
  readonly onShow: (tier: DiffFocusableTier) => void;
}) {
  if (props.categories.length === 0) return null;

  return (
    <div className="border-t border-border/70 py-1">
      {props.categories.map((category) => (
        <div
          key={category.tier}
          className="flex min-h-8 items-center gap-2 px-3 text-xs text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate">
            {TIER_LABELS[category.tier]} · {category.files.length}
            {props.incomplete ? "+" : ""} {category.files.length === 1 ? "file" : "files"} deferred
          </span>
          <DiffStatLabel
            additions={category.lineStat.additions}
            deletions={category.lineStat.deletions}
            className="shrink-0 text-[11px]"
            layout="inline"
          />
          <Button size="xs" variant="outline" onClick={() => props.onShow(category.tier)}>
            Show
          </Button>
        </div>
      ))}
    </div>
  );
}
