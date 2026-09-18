import { useEffect } from "react";
import type { DesktopBridge, DesktopUpstreamReleaseStatus } from "@t3tools/contracts";
import { GitMergeIcon } from "lucide-react";

import { stackedThreadToast, toastManager } from "./ui/toast";

type UpstreamReleaseShell = Pick<DesktopBridge, "openExternal">;

export function showUpstreamReleaseToast(
  shell: UpstreamReleaseShell,
  status: DesktopUpstreamReleaseStatus,
): void {
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: `Upstream T3 Code ${status.latestVersion} is available`,
      description: `This fork is built from ${status.currentVersion}. Sync it with upstream, rebuild, and reinstall to update.`,
      timeout: 0,
      actionProps: {
        children: "View release",
        onClick: () => void shell.openExternal(status.releaseUrl),
      },
      actionVariant: "outline",
      data: {
        hideCopyButton: true,
        leadingIcon: <GitMergeIcon aria-hidden="true" className="size-4 text-info" />,
      },
    }),
  );
}

export function UpstreamReleaseNotification() {
  useEffect(() => {
    const shell = window.desktopBridge;
    if (!shell?.checkUpstreamRelease) return;

    let cancelled = false;
    void shell
      .checkUpstreamRelease()
      .then((status) => {
        if (cancelled || !status?.updateAvailable) return;

        showUpstreamReleaseToast(shell, status);
      })
      .catch(() => {
        // A release check must never interfere with application startup.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
