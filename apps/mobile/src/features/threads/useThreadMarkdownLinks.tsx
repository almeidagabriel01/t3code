import * as Haptics from "expo-haptics";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import {
  needsWorkspaceBasenameLookup,
  pickWorkspaceLinkMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
  workspaceLinkLookupQuery,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import { AuthFilesystemReadScope, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { hostedThreadLink, parseThreadLinkHref } from "@t3tools/shared/threadLinks";

import { AppText as Text } from "../../components/ui/AppText";
import { type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { type VideoPreviewSource } from "../../components/ui/VideoPreviewModal";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  enrichedSkillDisplayName,
  enrichedSkillInstructionsPath,
  enrichedSkillReference,
} from "../../lib/enrichedLinkPresentation";
import { isPdfFile } from "../../lib/filePreview";
import {
  normalizeNativeMarkdownUrl,
  resolveMarkdownLinkPresentation,
} from "../../lib/markdownLinks";
import { markdownFileEmbedLabel, resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { enrichedThreadLinkCustomization } from "../../native/useEnrichedLinkVariants";
import { useMarkdownImageSources } from "../../native/useMarkdownImageSource";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import {
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
  type SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";
import { appAtomRegistry } from "../../state/atom-registry";
import { resolveThreadLink } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadShells } from "../../state/threads";
import {
  fileRoutePathSegments,
  resolveFileLinkPath,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";
import { type MarkdownLinkHandlers, type MarkdownStyleSet } from "./AssistantMarkdownContent";
import { fileChipClipboardPath, fileChipMenu, resolveFileChipTarget } from "./fileChipMenu";
import { ThreadInlineFilePreview } from "./ThreadInlineFilePreview";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";
import { ThreadMarkdownVideo } from "./ThreadMarkdownVideo";
import { useFileChipShare } from "./useFileChipShare";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/** Link and image handling for markdown written in one thread; previews close when the scope changes. */
export function useThreadMarkdownLinks(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot?: string | null | undefined;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined;
  readonly presentationKind: string;
  readonly markdownStyles: MarkdownStyleSet;
}) {
  const host = useMarkdownLinkHost({
    environmentId: props.environmentId,
    scope: [props.threadId, props.presentationKind],
    skills: props.skills,
    markdownStyles: props.markdownStyles,
  });
  const links = useMarkdownLinks(host, {
    threadId: props.threadId,
    workspaceRoot: props.workspaceRoot,
  });
  return { ...host, ...links };
}

/** A message's links from the host, with an image resolver that stays stable for its context. */
export function useMarkdownLinks(
  host: Pick<ReturnType<typeof useMarkdownLinkHost>, "imageSources" | "linksFor">,
  context: MarkdownLinkContext,
) {
  const { imageSources, linksFor } = host;
  const workspaceRoot = context.workspaceRoot ?? null;
  const resolveImageSource = useMemo(
    () => imageSources(context.threadId, workspaceRoot),
    [imageSources, context.threadId, workspaceRoot],
  );
  return linksFor(context, resolveImageSource);
}

/** Where a link was written: its thread (null outside one) and the root its paths resolve from. */
export interface MarkdownLinkContext {
  readonly threadId: ThreadId | null;
  readonly workspaceRoot?: string | null | undefined;
}

/**
 * One set of previews for a screen's markdown; `linksFor` builds each message's handlers from its
 * own context. A file link outside a thread has no file view to open.
 */
export function useMarkdownLinkHost(props: {
  readonly environmentId: EnvironmentId;
  /** What previews belong to; a change closes them and aborts a pending lookup. */
  readonly scope: ReadonlyArray<string>;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined;
  readonly markdownStyles: MarkdownStyleSet;
}) {
  const markdownLinkRequest = useRef<AbortController | null>(null);
  const onInlinePlaybackStart = () => {
    markdownLinkRequest.current?.abort();
  };
  useFocusEffect(useCallback(() => () => markdownLinkRequest.current?.abort(), []));
  // A preview belongs to the thread and presentation it was opened from: a change closes it and
  // aborts a pending lookup.
  const markdownLinkScope = JSON.stringify([props.environmentId, ...props.scope]);
  // oxlint-disable-next-line react/exhaustive-effect-dependencies, t3code/no-unreasoned-state-sync -- A scope change (thread or presentation) aborts the pending link lookup opened from the old scope.
  useLayoutEffect(() => () => markdownLinkRequest.current?.abort(), [markdownLinkScope]);
  const [preview, setPreview] = useState<{
    readonly scope: string;
    readonly file: FilePreviewSource | null;
    readonly video: VideoPreviewSource | null;
  } | null>(null);
  if (preview !== null && preview.scope !== markdownLinkScope) setPreview(null);
  const expandedFile = preview?.scope === markdownLinkScope ? preview.file : null;
  const expandedVideo = preview?.scope === markdownLinkScope ? preview.video : null;
  const openPreview = (
    scope: string,
    media: { file: FilePreviewSource } | { video: VideoPreviewSource },
  ) =>
    setPreview((current) => {
      const live = current?.scope === scope ? current : null;
      return {
        scope,
        file: "file" in media ? media.file : (live?.file ?? null),
        video: "video" in media ? media.video : (live?.video ?? null),
      };
    });
  const closeFilePreview = () =>
    setPreview((current) => (current === null ? null : { ...current, file: null }));
  const closeVideoPreview = () =>
    setPreview((current) => (current === null ? null : { ...current, video: null }));
  const fileShareSourceIdentifier = useId();
  const shareFileChip = useFileChipShare(props.environmentId, fileShareSourceIdentifier);
  const navigation = useNavigation();
  const openPullRequest = useOpenPullRequest();
  const openLinkedThread = useOpenLinkedThread();
  const resolveLinkedThread = (href: string) => {
    const link = parseThreadLinkHref(href);
    if (!link) return null;
    const resolved = resolveThreadLink(
      (atom) => appAtomRegistry.get(atom),
      link,
      props.environmentId,
    );
    if (resolved !== null || link.environmentId !== null) return resolved;
    // A v1 link names no environment, so it falls back to this message's.
    return scopeThreadRef(props.environmentId, link.threadId);
  };
  const imageSources = useMarkdownImageSources({ environmentId: props.environmentId });
  const onPressPreview = (source: FilePreviewSource) => {
    markdownLinkRequest.current?.abort();
    openPreview(markdownLinkScope, { file: source });
  };

  const linksFor = (
    context: MarkdownLinkContext,
    resolveImageSource: MarkdownImageSourceResolver,
  ) => {
    const { threadId, workspaceRoot } = context;
    const openThreadFile = (path: string, line?: number) => {
      if (threadId === null) return;
      navigation.navigate("ThreadFile", {
        environmentId: String(props.environmentId),
        threadId: String(threadId),
        path: fileRoutePathSegments(path),
        ...(line ? { line: String(line) } : {}),
      });
    };
    const openSkillInstructions = (path: string) => {
      void Haptics.selectionAsync();
      openThreadFile(path);
    };
    const onMarkdownLinkPress = (href: string, imageEmbed = false) => {
      markdownLinkRequest.current?.abort();
      const request = new AbortController();
      markdownLinkRequest.current = request;
      const skill = enrichedSkillReference(href, props.skills);
      if (skill) {
        const instructionsPath = enrichedSkillInstructionsPath(skill);
        if (instructionsPath) openSkillInstructions(instructionsPath);
        return;
      }
      if (parseThreadLinkHref(href)) {
        const target = resolveLinkedThread(href);
        if (target) {
          openLinkedThread({
            environmentId: String(target.environmentId),
            threadId: String(target.threadId),
          });
        }
        return;
      }
      const media = resolveMarkdownMediaPreview(href, {
        environmentId: props.environmentId,
        threadId: threadId ?? undefined,
        workspaceRoot,
        imageEmbed,
      });
      if (media && media.kind !== "file") {
        void Haptics.selectionAsync();
        const scope = markdownLinkScope;
        const openMediaPreview = () => {
          if (request.signal.aborted) return;
          openPreview(
            scope,
            media.kind === "video" ? { video: media.source } : { file: media.source },
          );
        };
        const resource = "resource" in media.source ? media.source.resource : null;
        const mediaPath = resource && "path" in resource ? resource.path : null;
        if (
          typeof mediaPath === "string" &&
          readEnvironmentScope(props.environmentId, AuthFilesystemReadScope)
        ) {
          void executeAtomQuery(
            appAtomRegistry,
            projectEnvironment.fileMetadata({
              environmentId: props.environmentId,
              input: { path: mediaPath },
            }),
            { signal: request.signal, reportFailure: false, reportDefect: false },
          ).then((result) => {
            if (request.signal.aborted) return;
            if (result._tag === "Success" && result.value?.kind === "directory") {
              openThreadFile(mediaPath);
            } else openMediaPreview();
          }, openMediaPreview);
        } else openMediaPreview();
        return;
      }

      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        const path = resolveFileLinkPath(workspaceRoot, presentation.path);
        if (path === null) return;
        const relativePath = resolveWorkspaceRelativeFilePath(workspaceRoot, path);
        const openAt = (target: string) => {
          if (request.signal.aborted) return;
          void Haptics.selectionAsync();
          openThreadFile(target, presentation.line);
        };
        if (
          workspaceRoot &&
          relativePath &&
          !/[\\/]$/.test(presentation.path) &&
          workspaceLinkLookupQuery(presentation.path, workspaceRoot) !== null &&
          readEnvironmentScope(props.environmentId, AuthFilesystemReadScope)
        ) {
          const originalPath = resolveWorkspaceFilePath(workspaceRoot, relativePath);
          void executeAtomQuery(
            appAtomRegistry,
            projectEnvironment.searchEntries({
              environmentId: props.environmentId,
              input: {
                cwd: workspaceRoot,
                query: workspaceLinkLookupQuery(relativePath, workspaceRoot) ?? relativePath,
                kind: "file",
                limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
              },
            }),
            { signal: request.signal, reportFailure: false, reportDefect: false },
          ).then(
            (result) => {
              const match =
                result._tag === "Success"
                  ? pickWorkspaceLinkMatch(relativePath, workspaceRoot, result.value.entries)
                  : null;
              if (!match || match === relativePath) {
                openAt(relativePath);
                return;
              }
              if (request.signal.aborted) return;
              void executeAtomQuery(
                appAtomRegistry,
                projectEnvironment.fileMetadata({
                  environmentId: props.environmentId,
                  input: { path: originalPath },
                }),
                { signal: request.signal, reportFailure: false, reportDefect: false },
              ).then(
                (metadata) =>
                  openAt(
                    metadata._tag === "Success" &&
                      (needsWorkspaceBasenameLookup(relativePath)
                        ? metadata.value?.kind !== "directory"
                        : metadata.value === null)
                      ? match
                      : relativePath,
                  ),
                () => openAt(relativePath),
              );
            },
            () => openAt(relativePath),
          );
        } else openAt(relativePath ?? path);
        return;
      }

      if (presentation.href) {
        if (/^https?:\/\//i.test(presentation.href) && isPdfFile({ name: presentation.href })) {
          openPreview(markdownLinkScope, {
            file: { kind: "pdf", uri: presentation.href, name: "Document.pdf" },
          });
          return;
        }
        void openPullRequest(presentation.href);
      }
    };
    const markdownLinkHandlers: MarkdownLinkHandlers = {
      fileEmbedLabel: (href, standalone) =>
        markdownFileEmbedLabel(
          href,
          {
            environmentId: props.environmentId,
            threadId: threadId ?? undefined,
            workspaceRoot,
          },
          standalone,
        ),
      onLinkPress: onMarkdownLinkPress,
      linkCustomization: enrichedThreadLinkCustomization,
      onImagePress: (href) => onMarkdownLinkPress(href, true),
      resolveImageSource,
      fileContextMenu: (href) => {
        const skill = enrichedSkillReference(href, props.skills);
        if (skill) {
          return {
            title: enrichedSkillDisplayName(skill),
            actions: [
              {
                id: "open-skill",
                title: "View instructions",
                disabled: !enrichedSkillInstructionsPath(skill),
              },
              { id: "copy-skill", title: "Copy skill" },
            ],
          };
        }
        const thread = resolveLinkedThread(href);
        if (thread) {
          return {
            title:
              appAtomRegistry.get(environmentThreadShells.threadShellAtom(thread))?.title ??
              "Thread",
            actions: [
              { id: "open-thread", title: "Open thread" },
              { id: "copy-thread-link", title: "Copy link" },
            ],
          };
        }
        const target = resolveFileChipTarget(href, workspaceRoot);
        return target ? fileChipMenu(target) : undefined;
      },
      onFileContextMenuAction: (href, actionId) => {
        const skill = enrichedSkillReference(href, props.skills);
        if (skill) {
          const instructionsPath = enrichedSkillInstructionsPath(skill);
          if (actionId === "open-skill" && instructionsPath)
            openSkillInstructions(instructionsPath);
          else if (actionId === "copy-skill") copyTextWithHaptic(`$${skill.name}`);
          return;
        }
        const thread = resolveLinkedThread(href);
        if (thread) {
          if (actionId === "open-thread") onMarkdownLinkPress(href);
          else if (actionId === "copy-thread-link") copyTextWithHaptic(hostedThreadLink(thread));
          return;
        }
        const target = resolveFileChipTarget(href, workspaceRoot);
        if (!target) return;
        switch (actionId) {
          case "copy-full-path":
          case "copy-relative-path": {
            const clipboardPath = fileChipClipboardPath(target, actionId);
            if (clipboardPath !== undefined) copyTextWithHaptic(clipboardPath);
            return;
          }
          case "open-file":
            onMarkdownLinkPress(href);
            return;
          case "save":
            if (threadId !== null) shareFileChip(target, threadId);
            return;
        }
      },
    };
    const renderMarkdownImage: MarkdownImageRenderer = (image) => {
      const media = resolveMarkdownMediaPreview(image.href, {
        environmentId: props.environmentId,
        threadId: threadId ?? undefined,
        workspaceRoot,
        imageEmbed: true,
      });
      if (media?.kind === "video") {
        return (
          <ThreadMarkdownVideo
            key={image.href}
            source={{ ...media.source, name: image.alt ?? media.source.name }}
            onPlaybackStart={onInlinePlaybackStart}
          />
        );
      }
      if (media?.kind === "audio") {
        return (
          <ThreadInlineFilePreview
            key={image.href}
            source={media.source}
            onOpen={() => onMarkdownLinkPress(image.href, true)}
            onPlaybackStart={onInlinePlaybackStart}
          />
        );
      }
      const fileLink = resolveMarkdownLinkPresentation(image.href);
      if (
        (media && (media.kind === "pdf" || media.kind === "document" || media.kind === "file")) ||
        (fileLink.kind === "file" && fileLink.line !== undefined)
      ) {
        const name =
          media?.source.name ?? (fileLink.kind === "file" ? fileLink.label : "Open file");
        return (
          <Text
            accessibilityRole="link"
            accessibilityLabel={`Open ${name}`}
            onPress={() => onMarkdownLinkPress(image.href, true)}
            style={{
              color: props.markdownStyles.nativeTextStyle.linkColor,
              fontSize: props.markdownStyles.nativeTextStyle.fontSize,
              lineHeight: props.markdownStyles.nativeTextStyle.lineHeight,
            }}
          >
            {name}
          </Text>
        );
      }
      const imageSource = classifyMarkdownImageSource(image.href, workspaceRoot ?? null);
      if (imageSource._tag === "Direct") {
        return (
          <ThreadMarkdownImageView
            uri={normalizeNativeMarkdownUrl(imageSource.uri)}
            sourceKey={imageSource.uri}
            format={
              /\.svg(?:[?#]|$)/i.test(imageSource.uri) ||
              imageSource.uri.startsWith("data:image/svg+xml")
                ? "svg"
                : undefined
            }
            unavailable={false}
            alt={image.alt}
            actionsSource={media?.source.actionsSource}
            onPressPreview={onPressPreview}
          />
        );
      }
      if (imageSource._tag === "Blocked" || threadId === null) {
        return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      }
      return (
        <ThreadMarkdownImage
          environmentId={props.environmentId}
          resource={{
            _tag: "media-file",
            threadId,
            path: imageSource.path,
          }}
          alt={image.alt}
          srcFragment={markdownImageSourceFragment(image.href)}
          actionsSource={media?.source.actionsSource}
          onPressPreview={onPressPreview}
        />
      );
    };
    return { linkHandlers: markdownLinkHandlers, renderImage: renderMarkdownImage };
  };

  return {
    linksFor,
    imageSources,
    onPressPreview,
    onInlinePlaybackStart,
    expandedFile,
    expandedVideo,
    closeFilePreview,
    closeVideoPreview,
    fileShareSourceIdentifier,
  };
}
