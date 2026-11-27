import { HStack, Image, Link, Button, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  background,
  buttonStyle,
  containerBackground,
  environment,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  padding,
  resizable,
  shapes,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type {
  BrowneHubFleetItem,
  BrowneHubFleetSeverity,
  BrowneHubSnapshot,
  BrowneHubTab,
  BrowneHubTopic,
  BrowneHubTopicKind,
} from "./browneHubSnapshot";

export type BrowneHubViewMode = "auto" | "command" | "latest" | "running" | "fleet";

export interface BrowneHubConfiguration {
  readonly viewMode?: BrowneHubViewMode;
  readonly projectKey?: string;
  readonly urgentTakeover?: boolean;
}

// Widget serialization excludes module-scope helpers; keep all runtime state inside BrowneHubWidget.
export function BrowneHubWidget(
  publishedProps: Partial<BrowneHubSnapshot>,
  widgetEnvironment: WidgetEnvironment<BrowneHubConfiguration> & {
    readonly showsContainerBackground?: boolean;
  },
) {
  "widget";

  const props = publishedProps ?? {};
  const brandName = "Browne";
  const family = widgetEnvironment.widgetFamily ?? "systemMedium";
  const accessory = family === "accessoryRectangular";
  const small = family === "systemSmall";
  const large = family === "systemLarge" || family === "systemExtraLarge";

  const monochrome =
    widgetEnvironment.widgetRenderingMode === "accented" ||
    widgetEnvironment.widgetRenderingMode === "vibrant" ||
    widgetEnvironment.isLuminanceReduced === true;

  const themeMode = props.theme?.mode;
  const appearance =
    themeMode === "light" || themeMode === "dark"
      ? themeMode
      : widgetEnvironment.colorScheme === "light"
        ? "light"
        : "dark";
  const isLightScheme = appearance === "light";
  const useCustomTheme =
    !accessory && !monochrome && widgetEnvironment.showsContainerBackground !== false;
  const themePalette = useCustomTheme ? props.theme?.[appearance] : undefined;

  type Foreground = Parameters<typeof foregroundStyle>[0];
  const primaryFg: Foreground = themePalette?.foreground ?? {
    type: "hierarchical",
    style: "primary",
  };
  const secondaryFg: Foreground = themePalette?.secondary ?? {
    type: "hierarchical",
    style: "secondary",
  };
  const cardBg = isLightScheme ? "#f2f4f7" : "#22262e";
  const subtleBg = isLightScheme ? "#e7ebf0" : "#2a2f3a";
  const pillActiveBg = isLightScheme ? "#111827" : "#f3f4f6";
  const pillActiveFg = isLightScheme ? "#ffffff" : "#111827";
  const urgentTint = themePalette?.danger ?? (isLightScheme ? "#dc2626" : "#f87171");
  const approvalTint = isLightScheme ? "#d97706" : "#fbbf24";
  const inputTint = isLightScheme ? "#0284c7" : "#38bdf8";
  const okTint = isLightScheme ? "#059669" : "#34d399";
  const talkFill = isLightScheme ? "#111827" : "#ffffff";
  const talkFg = isLightScheme ? "#ffffff" : "#111827";

  const pt = props.text;
  const talkText = pt?.talk ?? "Talk to Fleet";
  const talkShortText = pt?.talkShort ?? "Talk";
  const quickTaskText = pt?.quickTask ?? "Quick task";
  const quickShortText = pt?.quickShort ?? "Quick";
  const newTaskText = pt?.newTask ?? "New task";
  const newShortText = pt?.newShort ?? "New";
  const reviewOpenText = pt?.reviewOpen ?? "Open & Review";
  const latestTabText = pt?.latest ?? "Latest";
  const runningTabText = pt?.runningTab ?? "Running";
  const projectsTabText = pt?.projectsTab ?? "Projects";
  const fleetTabText = pt?.fleetTab ?? "Fleet";
  const approvalText = pt?.approval ?? "Approve";
  const inputText = pt?.input ?? "Input";
  const failedText = pt?.failed ?? "Failed";
  const limitedText = pt?.limited ?? "Limit";
  const runningBadgeText = pt?.runningBadge ?? "Running";
  const doneText = pt?.done ?? "Done";
  const allClearText = pt?.allClear ?? "All clear";
  const needYouText = pt?.needYou ?? "need you";
  const urgentWordText = pt?.urgent ?? "URGENT";
  const activeWordText = pt?.active ?? "active";
  const outOfDateText = pt?.outOfDate ?? "Out of date";
  const openToSyncText = pt?.openToSync ?? "Open Browne to sync agents";
  const noTopicsText = pt?.noTopics ?? "No recent topics yet";
  const noRunningText = pt?.noRunning ?? "No active agents";
  const noFleetText = pt?.noFleet ?? "No Fleet alerts";
  const allProjectsText = pt?.allProjects ?? "All projects";
  const runningLabelText = pt?.runningLabel ?? "Running";
  const doneTodayLabelText = pt?.doneTodayLabel ?? "Done today";
  const quotaLabelText = pt?.quotaLabel ?? "Quota left";
  const hostsLabelText = pt?.hostsLabel ?? "Hosts";
  const urgentLabelText = pt?.urgentLabel ?? "Urgent";
  const syncedLabelText = pt?.syncedLabel ?? "Synced";
  const staleHintText = pt?.staleHint ?? "Open Browne to refresh";

  const config = widgetEnvironment.configuration;
  const viewMode: BrowneHubViewMode = config?.viewMode ?? "auto";
  const projectKeyConfig =
    typeof config?.projectKey === "string" && config.projectKey.length > 0
      ? config.projectKey
      : "all";
  const allowTakeover = config?.urgentTakeover !== false;

  const projects = props.projects ?? [];
  const pinnedProject =
    projectKeyConfig !== "all"
      ? projects.find((entry) => entry.key === projectKeyConfig)
      : undefined;
  const scopeFilter = (topic: BrowneHubTopic) =>
    projectKeyConfig === "all" || topic.projectKey === projectKeyConfig;

  const hasPublishedData = props.version === 1;
  const scopedUrgent = (props.urgentTopics ?? []).filter(scopeFilter);
  const scopedRunning = (props.runningTopics ?? []).filter(scopeFilter);
  const scopedLatest = (props.latestTopics ?? []).filter(scopeFilter);
  const scopedActive = [...scopedUrgent, ...scopedRunning];
  const fleetItems = props.fleetItems ?? [];

  const stats = props.stats;
  const urgentCount =
    projectKeyConfig === "all"
      ? (stats?.urgentCount ?? scopedUrgent.length)
      : (pinnedProject?.urgentCount ?? scopedUrgent.length);
  const runningCount =
    projectKeyConfig === "all"
      ? (stats?.runningCount ?? scopedRunning.length)
      : (pinnedProject?.runningCount ?? scopedRunning.length);
  const doneTodayCount =
    projectKeyConfig === "all"
      ? (stats?.doneTodayCount ?? 0)
      : (pinnedProject?.doneTodayCount ?? 0);
  const quotaPercent = stats?.tightestQuotaPercent ?? null;
  const hostsUpLabel = stats?.hostsUpLabel ?? null;

  const isUrgentTakeover =
    allowTakeover && scopedUrgent.length > 0 && (viewMode === "auto" || viewMode === "command");
  const isStale = props.stale === true;

  const allowInteractiveTabs =
    viewMode === "auto" && projectKeyConfig === "all" && !isUrgentTakeover;
  const activeTab: BrowneHubTab = allowInteractiveTabs
    ? (props.activeTab ?? "latest")
    : viewMode === "running"
      ? "running"
      : viewMode === "fleet"
        ? "fleet"
        : "latest";

  const slideCount = projects.length;
  const rawSlideIndex = props.projectSlideIndex ?? 0;
  const activeProjectSlideIndex =
    slideCount > 0 ? ((rawSlideIndex % slideCount) + slideCount) % slideCount : 0;
  const activeProjectSlide = slideCount > 0 ? projects[activeProjectSlideIndex] : undefined;

  const patchProps = (patch: Partial<BrowneHubSnapshot>): void => patch as unknown as void;

  const kindColor = (kind: BrowneHubTopicKind): Foreground => {
    if (monochrome) return primaryFg;
    switch (kind) {
      case "approval":
        return approvalTint;
      case "input":
      case "request":
        return inputTint;
      case "failed":
      case "limited":
        return urgentTint;
      case "running":
        return inputTint;
      case "done":
      default:
        return okTint;
    }
  };

  const kindBadgeBg = (kind: BrowneHubTopicKind): string => {
    if (monochrome) return subtleBg;
    switch (kind) {
      case "approval":
        return isLightScheme ? "#fef3c7" : "#3a2c14";
      case "input":
      case "request":
        return isLightScheme ? "#e0f2fe" : "#172d42";
      case "failed":
      case "limited":
        return isLightScheme ? "#fee2e2" : "#3d1a1d";
      case "running":
        return isLightScheme ? "#e0f2fe" : "#182b3a";
      case "done":
      default:
        return isLightScheme ? "#d1fae5" : "#153227";
    }
  };

  const kindLabel = (kind: BrowneHubTopicKind, fallback?: string): string => {
    switch (kind) {
      case "approval":
        return fallback ?? approvalText;
      case "input":
      case "request":
        return fallback ?? inputText;
      case "failed":
        return fallback ?? failedText;
      case "limited":
        return fallback ?? limitedText;
      case "running":
        return fallback ?? runningBadgeText;
      case "done":
        return fallback ?? doneText;
    }
  };

  const severityColor = (severity: BrowneHubFleetSeverity): Foreground => {
    if (monochrome) return primaryFg;
    switch (severity) {
      case "alert":
        return urgentTint;
      case "mail":
        return inputTint;
      case "plan":
        return approvalTint;
      case "ok":
      default:
        return okTint;
    }
  };

  const severityBg = (severity: BrowneHubFleetSeverity): string => {
    if (monochrome) return subtleBg;
    switch (severity) {
      case "alert":
        return isLightScheme ? "#fee2e2" : "#3d1a1d";
      case "mail":
        return isLightScheme ? "#e0f2fe" : "#172d42";
      case "plan":
        return isLightScheme ? "#fef3c7" : "#3a2c14";
      case "ok":
      default:
        return isLightScheme ? "#d1fae5" : "#153227";
    }
  };

  const urgentHeroBg = isLightScheme ? "#fee2e2" : "#391a1d";
  const widgetBg: string = isUrgentTakeover
    ? isLightScheme
      ? "#fff5f5"
      : "#251417"
    : (themePalette?.background ?? (isLightScheme ? "#ffffff" : "#16181d"));

  const wholeWidgetLink =
    small || accessory ? (scopedUrgent[0]?.deepLink ?? "browne://talk-to-fleet") : null;

  const rootModifiers = [
    ...(accessory
      ? [containerBackground("clear", "widget")]
      : [containerBackground(widgetBg, "widget"), environment("colorScheme", appearance)]),
    ...(wholeWidgetLink ? [widgetURL(wholeWidgetLink)] : []),
  ];

  const renderMark = (height: number) =>
    monochrome || accessory ? (
      <HStack modifiers={[frame({ width: height * 0.77, height }), foregroundStyle(primaryFg)]}>
        <Image assetName="BrowneMark" modifiers={[resizable()]} />
      </HStack>
    ) : (
      <HStack
        alignment="center"
        modifiers={[
          frame({ width: height + 4, height: height + 4, alignment: "center" }),
          background(
            "#18100b",
            shapes.roundedRectangle({ cornerRadius: 4.5, roundedCornerStyle: "continuous" }),
          ),
        ]}
      >
        <HStack
          modifiers={[
            frame({ width: (height - 2) * 0.77, height: height - 2 }),
            foregroundStyle("#f7f2ea"),
          ]}
        >
          <Image assetName="BrowneMark" modifiers={[resizable()]} />
        </HStack>
      </HStack>
    );

  const renderStatTile = (value: string, label: string, accent?: Foreground) => (
    <VStack
      alignment="leading"
      spacing={1}
      modifiers={[
        padding({ horizontal: 8, vertical: 5 }),
        frame({ maxWidth: Infinity, alignment: "leading" }),
        background(
          cardBg,
          shapes.roundedRectangle({ cornerRadius: 10, roundedCornerStyle: "continuous" }),
        ),
      ]}
    >
      <Text
        modifiers={[
          font({ weight: "bold", size: 13, design: "monospaced" }),
          foregroundStyle(accent ?? primaryFg),
          lineLimit(1),
        ]}
      >
        {value}
      </Text>
      <Text modifiers={[font({ size: 10 }), foregroundStyle(secondaryFg), lineLimit(1)]}>
        {label}
      </Text>
    </VStack>
  );

  const renderActionPill = (
    destination: string,
    symbol: "waveform" | "square.and.pencil" | "plus" | "arrow.up.right",
    label: string,
    emphasis: "primary" | "urgent" | "secondary",
    compactHeight = false,
  ) => {
    const bgColor =
      emphasis === "urgent" ? urgentTint : emphasis === "primary" ? talkFill : subtleBg;
    const fgColor: Foreground =
      emphasis === "urgent" ? "#ffffff" : emphasis === "primary" ? talkFg : primaryFg;
    return (
      <Link key={destination} destination={destination}>
        <HStack
          spacing={5}
          alignment="center"
          modifiers={[
            padding({ horizontal: 8, vertical: compactHeight ? 6 : 7 }),
            frame({ maxWidth: Infinity, alignment: "center" }),
            background(
              bgColor,
              shapes.roundedRectangle({ cornerRadius: 11, roundedCornerStyle: "continuous" }),
            ),
          ]}
        >
          <Spacer minLength={0} />
          <Image systemName={symbol} size={12} modifiers={[foregroundStyle(fgColor)]} />
          <Text
            modifiers={[
              font({ weight: "semibold", size: 11 }),
              foregroundStyle(fgColor),
              lineLimit(1),
            ]}
          >
            {label}
          </Text>
          <Spacer minLength={0} />
        </HStack>
      </Link>
    );
  };

  const renderIconLink = (
    destination: string,
    symbol: "waveform" | "square.and.pencil",
    urgentStyle: boolean,
  ) => (
    <Link key={destination} destination={destination}>
      <HStack
        alignment="center"
        modifiers={[
          frame({ width: 28, height: 26, alignment: "center" }),
          background(
            urgentStyle ? urgentTint : subtleBg,
            shapes.roundedRectangle({ cornerRadius: 8, roundedCornerStyle: "continuous" }),
          ),
        ]}
      >
        <Image
          systemName={symbol}
          size={12}
          modifiers={[foregroundStyle(urgentStyle ? "#ffffff" : primaryFg)]}
        />
      </HStack>
    </Link>
  );

  const renderTopicRow = (
    row: BrowneHubTopic,
    compactRow: boolean,
    showProjectSubtitle: boolean,
  ) => (
    <Link key={row.id} destination={row.deepLink}>
      <HStack
        spacing={7}
        alignment="center"
        modifiers={[
          padding({ horizontal: 8, vertical: compactRow ? 5 : 6 }),
          frame({ maxWidth: Infinity, alignment: "leading" }),
          background(
            cardBg,
            shapes.roundedRectangle({ cornerRadius: 10, roundedCornerStyle: "continuous" }),
          ),
        ]}
      >
        <VStack
          alignment="leading"
          spacing={1}
          modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
        >
          <Text
            modifiers={[
              font({ weight: "semibold", size: compactRow ? 11.5 : 12 }),
              foregroundStyle(primaryFg),
              lineLimit(1),
            ]}
          >
            {row.title}
          </Text>
          {showProjectSubtitle ? (
            <Text modifiers={[font({ size: 10 }), foregroundStyle(secondaryFg), lineLimit(1)]}>
              {row.projectTitle}
            </Text>
          ) : null}
        </VStack>
        <Spacer minLength={4} />
        <Text
          modifiers={[
            font({ weight: "bold", size: 10 }),
            foregroundStyle(kindColor(row.kind)),
            padding({ horizontal: 6, vertical: 2 }),
            background(
              kindBadgeBg(row.kind),
              shapes.roundedRectangle({ cornerRadius: 6, roundedCornerStyle: "continuous" }),
            ),
            layoutPriority(1),
          ]}
        >
          {kindLabel(row.kind, row.statusLabel)}
        </Text>
      </HStack>
    </Link>
  );

  const renderFleetRow = (item: BrowneHubFleetItem, compactRow: boolean) => (
    <Link key={item.id} destination={item.deepLink}>
      <HStack
        spacing={7}
        alignment="center"
        modifiers={[
          padding({ horizontal: 8, vertical: compactRow ? 5 : 6 }),
          frame({ maxWidth: Infinity, alignment: "leading" }),
          background(
            cardBg,
            shapes.roundedRectangle({ cornerRadius: 10, roundedCornerStyle: "continuous" }),
          ),
        ]}
      >
        <VStack
          alignment="leading"
          spacing={1}
          modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
        >
          <Text
            modifiers={[
              font({ weight: "semibold", size: compactRow ? 11.5 : 12 }),
              foregroundStyle(primaryFg),
              lineLimit(1),
            ]}
          >
            {item.title}
          </Text>
          {compactRow ? null : (
            <Text modifiers={[font({ size: 10 }), foregroundStyle(secondaryFg), lineLimit(1)]}>
              {item.subtitle}
            </Text>
          )}
        </VStack>
        <Spacer minLength={4} />
        <Text
          modifiers={[
            font({ weight: "bold", size: 10 }),
            foregroundStyle(severityColor(item.severity)),
            padding({ horizontal: 6, vertical: 2 }),
            background(
              severityBg(item.severity),
              shapes.roundedRectangle({ cornerRadius: 6, roundedCornerStyle: "continuous" }),
            ),
            layoutPriority(1),
          ]}
        >
          {item.badge}
        </Text>
      </HStack>
    </Link>
  );

  const renderTabButton = (tab: BrowneHubTab, label: string) => {
    const selected = activeTab === tab;
    return (
      <Button
        key={tab}
        onPress={() => patchProps({ activeTab: tab })}
        modifiers={[buttonStyle("plain")]}
      >
        <HStack
          alignment="center"
          modifiers={[
            padding({ horizontal: 6, vertical: 4 }),
            frame({ maxWidth: Infinity, alignment: "center" }),
            background(
              selected ? pillActiveBg : "transparent",
              shapes.roundedRectangle({ cornerRadius: 7, roundedCornerStyle: "continuous" }),
            ),
          ]}
        >
          <Text
            modifiers={[
              font({ weight: "semibold", size: 10.5 }),
              foregroundStyle(selected ? pillActiveFg : secondaryFg),
              lineLimit(1),
            ]}
          >
            {label}
          </Text>
        </HStack>
      </Button>
    );
  };

  // Lock Screen rectangular widget
  if (accessory) {
    const accessoryRows = (scopedUrgent.length > 0 ? scopedUrgent : scopedLatest).slice(0, 2);
    return (
      <VStack alignment="leading" spacing={2} modifiers={rootModifiers}>
        <HStack spacing={5} alignment="center">
          <Image
            systemName={scopedUrgent.length > 0 ? "exclamationmark.triangle.fill" : "waveform"}
            size={11}
          />
          <Text
            modifiers={[
              font({ weight: "bold", size: 12 }),
              foregroundStyle(primaryFg),
              lineLimit(1),
            ]}
          >
            {scopedUrgent.length > 0
              ? `${urgentCount} ${urgentWordText}`
              : runningCount > 0
                ? `${runningCount} ${activeWordText}`
                : brandName}
          </Text>
          <Spacer minLength={0} />
        </HStack>
        {accessoryRows.length > 0 ? (
          accessoryRows.map((row) => (
            <Text
              key={row.id}
              modifiers={[font({ size: 11 }), foregroundStyle(secondaryFg), lineLimit(1)]}
            >
              {`${kindLabel(row.kind, row.statusLabel)}: ${row.title}`}
            </Text>
          ))
        ) : (
          <Text modifiers={[font({ size: 11 }), foregroundStyle(secondaryFg), lineLimit(1)]}>
            {talkText}
          </Text>
        )}
      </VStack>
    );
  }

  // Small 2x2 launcher / status widget
  if (small) {
    const topTopic = scopedUrgent[0] ?? scopedRunning[0] ?? scopedLatest[0];
    return (
      <VStack alignment="leading" spacing={8} modifiers={rootModifiers}>
        <HStack spacing={6} alignment="center">
          {renderMark(12)}
          <Spacer minLength={0} />
          <Text
            modifiers={[
              font({ weight: "bold", size: 10 }),
              foregroundStyle(isUrgentTakeover ? urgentTint : okTint),
              padding({ horizontal: 6, vertical: 2 }),
              background(
                isUrgentTakeover ? urgentHeroBg : subtleBg,
                shapes.capsule({ roundedCornerStyle: "continuous" }),
              ),
              lineLimit(1),
            ]}
          >
            {isUrgentTakeover
              ? `${urgentCount} ${urgentWordText}`
              : runningCount > 0
                ? `${runningCount} ${activeWordText}`
                : allClearText}
          </Text>
        </HStack>

        {isUrgentTakeover && topTopic ? (
          <VStack alignment="leading" spacing={4}>
            <Text
              modifiers={[
                font({ weight: "bold", size: 10 }),
                foregroundStyle(kindColor(topTopic.kind)),
                lineLimit(1),
              ]}
            >
              {kindLabel(topTopic.kind, topTopic.statusLabel)}
            </Text>
            <Text
              modifiers={[
                font({ weight: "semibold", size: 13 }),
                foregroundStyle(primaryFg),
                lineLimit(3),
              ]}
            >
              {topTopic.title}
            </Text>
            <Text modifiers={[font({ size: 10 }), foregroundStyle(secondaryFg), lineLimit(1)]}>
              {topTopic.projectTitle}
            </Text>
          </VStack>
        ) : (
          <VStack alignment="leading" spacing={6}>
            <HStack spacing={5} alignment="center">
              <Image systemName="waveform" size={13} modifiers={[foregroundStyle(primaryFg)]} />
              <Text
                modifiers={[
                  font({ weight: "bold", size: 13 }),
                  foregroundStyle(primaryFg),
                  lineLimit(1),
                ]}
              >
                {talkText}
              </Text>
            </HStack>
            {topTopic ? (
              <VStack alignment="leading" spacing={2}>
                <Text
                  modifiers={[
                    font({ weight: "medium", size: 11 }),
                    foregroundStyle(primaryFg),
                    lineLimit(2),
                  ]}
                >
                  {topTopic.title}
                </Text>
                <Text modifiers={[font({ size: 10 }), foregroundStyle(secondaryFg), lineLimit(1)]}>
                  {`${runningCount} ${activeWordText} · ${doneTodayCount} ${doneText}`}
                </Text>
              </VStack>
            ) : (
              <Text modifiers={[font({ size: 11 }), foregroundStyle(secondaryFg), lineLimit(2)]}>
                {hasPublishedData ? noTopicsText : openToSyncText}
              </Text>
            )}
          </VStack>
        )}

        <Spacer minLength={0} />
      </VStack>
    );
  }

  // Medium 4x2 (Stack-ready layout)
  if (!large) {
    if (isUrgentTakeover) {
      const topUrgent = scopedUrgent.slice(0, 2);
      return (
        <VStack alignment="leading" spacing={7} modifiers={rootModifiers}>
          <HStack spacing={6} alignment="center">
            <Text
              modifiers={[
                font({ weight: "bold", size: 10.5 }),
                foregroundStyle("#ffffff"),
                padding({ horizontal: 8, vertical: 3 }),
                background(urgentTint, shapes.capsule({ roundedCornerStyle: "continuous" })),
                lineLimit(1),
              ]}
            >
              {`${urgentCount} ${urgentWordText}`}
            </Text>
            {pinnedProject ? (
              <Text
                modifiers={[
                  font({ weight: "semibold", size: 11 }),
                  foregroundStyle(secondaryFg),
                  lineLimit(1),
                ]}
              >
                {pinnedProject.title}
              </Text>
            ) : null}
            <Spacer minLength={0} />
            {renderIconLink("browne://talk-to-fleet", "waveform", true)}
            {renderIconLink("browne://new/scratch", "square.and.pencil", false)}
          </HStack>
          <VStack alignment="leading" spacing={5}>
            {topUrgent.map((row) => renderTopicRow(row, true, true))}
          </VStack>
          <Spacer minLength={0} />
        </VStack>
      );
    }

    if (viewMode === "latest" || viewMode === "running" || viewMode === "fleet") {
      const headerLabel =
        viewMode === "running"
          ? runningTabText
          : viewMode === "fleet"
            ? fleetTabText
            : (pinnedProject?.title ?? latestTabText);
      const thirdStatValue =
        hostsUpLabel ?? (quotaPercent !== null ? `${quotaPercent}%` : `${urgentCount}`);
      const thirdStatLabel = hostsUpLabel
        ? hostsLabelText
        : quotaPercent !== null
          ? quotaLabelText
          : urgentLabelText;
      const rows = viewMode === "running" ? scopedActive.slice(0, 3) : scopedLatest.slice(0, 2);

      return (
        <VStack alignment="leading" spacing={7} modifiers={rootModifiers}>
          <HStack spacing={6} alignment="center">
            {renderMark(12)}
            <Text
              modifiers={[
                font({ weight: "bold", size: 12 }),
                foregroundStyle(primaryFg),
                lineLimit(1),
              ]}
            >
              {headerLabel}
            </Text>
            <Spacer minLength={0} />
            {viewMode === "fleet" && hostsUpLabel ? (
              <Text
                modifiers={[
                  font({ weight: "semibold", size: 10 }),
                  foregroundStyle(okTint),
                  padding({ horizontal: 7, vertical: 3 }),
                  background(subtleBg, shapes.capsule({ roundedCornerStyle: "continuous" })),
                ]}
              >
                {hostsUpLabel}
              </Text>
            ) : null}
            {viewMode === "running" && scopedActive.length > 0 ? (
              <Text
                modifiers={[
                  font({ weight: "semibold", size: 10 }),
                  foregroundStyle(scopedUrgent.length > 0 ? urgentTint : inputTint),
                  padding({ horizontal: 7, vertical: 3 }),
                  background(subtleBg, shapes.capsule({ roundedCornerStyle: "continuous" })),
                  lineLimit(1),
                ]}
              >
                {`${scopedActive.length} ${activeWordText}`}
              </Text>
            ) : null}
            {renderIconLink("browne://talk-to-fleet", "waveform", false)}
            {renderIconLink("browne://new/scratch", "square.and.pencil", false)}
          </HStack>

          {viewMode === "latest" ? (
            <HStack spacing={6}>
              {renderStatTile(
                String(runningCount),
                runningLabelText,
                runningCount > 0 ? inputTint : undefined,
              )}
              {renderStatTile(String(doneTodayCount), doneTodayLabelText, okTint)}
              {renderStatTile(thirdStatValue, thirdStatLabel)}
            </HStack>
          ) : null}

          {viewMode === "fleet" ? (
            fleetItems.length > 0 ? (
              <VStack alignment="leading" spacing={5}>
                {fleetItems.slice(0, 3).map((item) => renderFleetRow(item, true))}
              </VStack>
            ) : (
              <Text modifiers={[font({ size: 11.5 }), foregroundStyle(secondaryFg), lineLimit(2)]}>
                {hasPublishedData ? noFleetText : openToSyncText}
              </Text>
            )
          ) : rows.length > 0 ? (
            <VStack alignment="leading" spacing={5}>
              {rows.map((row) =>
                renderTopicRow(row, true, viewMode === "running" && !pinnedProject),
              )}
            </VStack>
          ) : viewMode === "running" ? (
            !hasPublishedData ? (
              <Text modifiers={[font({ size: 11.5 }), foregroundStyle(secondaryFg), lineLimit(2)]}>
                {openToSyncText}
              </Text>
            ) : scopedLatest.length > 0 ? (
              <VStack alignment="leading" spacing={5}>
                <Text
                  modifiers={[font({ size: 10.5 }), foregroundStyle(secondaryFg), lineLimit(1)]}
                >
                  {doneTodayCount > 0
                    ? `${noRunningText} · ${doneTodayCount} ${doneTodayLabelText.toLowerCase()}`
                    : noRunningText}
                </Text>
                {scopedLatest.slice(0, 2).map((row) => renderTopicRow(row, true, !pinnedProject))}
              </VStack>
            ) : (
              <VStack alignment="leading" spacing={7}>
                <Text
                  modifiers={[font({ size: 11.5 }), foregroundStyle(secondaryFg), lineLimit(1)]}
                >
                  {noRunningText}
                </Text>
                <HStack spacing={6}>
                  {renderActionPill(
                    "browne://talk-to-fleet",
                    "waveform",
                    talkText,
                    "primary",
                    true,
                  )}
                  {renderActionPill(
                    "browne://new/scratch",
                    "square.and.pencil",
                    quickTaskText,
                    "secondary",
                    true,
                  )}
                </HStack>
              </VStack>
            )
          ) : (
            <Text modifiers={[font({ size: 11.5 }), foregroundStyle(secondaryFg), lineLimit(2)]}>
              {hasPublishedData ? noTopicsText : openToSyncText}
            </Text>
          )}
          <Spacer minLength={0} />
        </VStack>
      );
    }

    // Medium default "auto" / "command": Quick actions + top 2 latest/active topics
    const headerTitle = pinnedProject?.title ?? brandName;
    const statusChip = isStale
      ? outOfDateText
      : runningCount > 0
        ? `${runningCount} ${activeWordText}`
        : quotaPercent !== null
          ? `${quotaPercent}%`
          : allClearText;
    const mediumRows = (
      scopedRunning.length > 0
        ? [...scopedRunning, ...scopedLatest.filter((t) => t.kind !== "running")]
        : scopedLatest
    ).slice(0, 2);

    return (
      <VStack alignment="leading" spacing={7} modifiers={rootModifiers}>
        <HStack spacing={6} alignment="center">
          {renderMark(12)}
          <Text
            modifiers={[
              font({ weight: "bold", size: 12 }),
              foregroundStyle(primaryFg),
              lineLimit(1),
            ]}
          >
            {headerTitle}
          </Text>
          <Spacer minLength={0} />
          <Text
            modifiers={[
              font({ weight: "semibold", size: 10 }),
              foregroundStyle(isStale ? secondaryFg : runningCount > 0 ? inputTint : okTint),
              padding({ horizontal: 7, vertical: 2 }),
              background(subtleBg, shapes.capsule({ roundedCornerStyle: "continuous" })),
              lineLimit(1),
            ]}
          >
            {statusChip}
          </Text>
        </HStack>

        <HStack spacing={6}>
          {renderActionPill("browne://talk-to-fleet", "waveform", talkText, "primary", true)}
          {renderActionPill(
            "browne://new/scratch",
            "square.and.pencil",
            quickTaskText,
            "secondary",
            true,
          )}
        </HStack>

        {mediumRows.length > 0 ? (
          <VStack alignment="leading" spacing={5}>
            {mediumRows.map((row) => renderTopicRow(row, true, false))}
          </VStack>
        ) : (
          <Text modifiers={[font({ size: 11.5 }), foregroundStyle(secondaryFg), lineLimit(2)]}>
            {hasPublishedData ? noTopicsText : openToSyncText}
          </Text>
        )}
        <Spacer minLength={0} />
      </VStack>
    );
  }

  // Large 4x4 Command Center
  if (isUrgentTakeover) {
    const hero = scopedUrgent[0]!;
    const secondaryUrgent = scopedUrgent.slice(1, 4);
    return (
      <VStack alignment="leading" spacing={9} modifiers={rootModifiers}>
        <HStack spacing={6} alignment="center">
          {renderMark(13)}
          <Text
            modifiers={[
              font({ weight: "bold", size: 13 }),
              foregroundStyle(primaryFg),
              lineLimit(1),
            ]}
          >
            {pinnedProject?.title ?? brandName}
          </Text>
          <Spacer minLength={0} />
          <Text
            modifiers={[
              font({ weight: "bold", size: 10.5 }),
              foregroundStyle("#ffffff"),
              padding({ horizontal: 8, vertical: 3 }),
              background(urgentTint, shapes.capsule({ roundedCornerStyle: "continuous" })),
              lineLimit(1),
            ]}
          >
            {`${urgentCount} ${needYouText}`}
          </Text>
        </HStack>

        <VStack
          alignment="leading"
          spacing={7}
          modifiers={[
            padding({ all: 10 }),
            frame({ maxWidth: Infinity, alignment: "leading" }),
            background(
              urgentHeroBg,
              shapes.roundedRectangle({ cornerRadius: 13, roundedCornerStyle: "continuous" }),
            ),
          ]}
        >
          <HStack spacing={6} alignment="center">
            <Text
              modifiers={[
                font({ weight: "bold", size: 10 }),
                foregroundStyle(kindColor(hero.kind)),
                lineLimit(1),
              ]}
            >
              {kindLabel(hero.kind, hero.statusLabel)}
            </Text>
            <Spacer minLength={0} />
            <Text modifiers={[font({ size: 10 }), foregroundStyle(secondaryFg), lineLimit(1)]}>
              {hero.projectTitle}
            </Text>
          </HStack>
          <Link destination={hero.deepLink}>
            <Text
              modifiers={[
                font({ weight: "bold", size: 13.5 }),
                foregroundStyle(primaryFg),
                lineLimit(2),
              ]}
            >
              {hero.title}
            </Text>
          </Link>
          <HStack spacing={6}>
            {renderActionPill(hero.deepLink, "arrow.up.right", reviewOpenText, "primary", true)}
            {renderActionPill("browne://talk-to-fleet", "waveform", talkShortText, "urgent", true)}
          </HStack>
        </VStack>

        {secondaryUrgent.length > 0 ? (
          <VStack alignment="leading" spacing={5}>
            {secondaryUrgent.map((row) => renderTopicRow(row, true, true))}
          </VStack>
        ) : (
          <Spacer minLength={0} />
        )}

        <Spacer minLength={0} />
        <HStack spacing={6}>
          {renderActionPill(
            "browne://new/scratch",
            "square.and.pencil",
            quickTaskText,
            "secondary",
            true,
          )}
          {renderActionPill("browne://new", "plus", newTaskText, "secondary", true)}
        </HStack>
      </VStack>
    );
  }

  // Normal Large 4x4
  const thirdStatValue =
    hostsUpLabel ?? (quotaPercent !== null ? `${quotaPercent}%` : `${urgentCount}`);
  const thirdStatLabel = hostsUpLabel
    ? hostsLabelText
    : quotaPercent !== null
      ? quotaLabelText
      : urgentLabelText;
  const activeTopicsForLarge =
    activeTab === "running"
      ? scopedActive.slice(0, 4)
      : activeTab === "projects" && activeProjectSlide
        ? activeProjectSlide.topics.slice(0, 3)
        : scopedLatest.slice(0, allowInteractiveTabs ? 3 : 4);

  return (
    <VStack alignment="leading" spacing={8} modifiers={rootModifiers}>
      <HStack spacing={6} alignment="center">
        {renderMark(13)}
        <Text
          modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle(primaryFg), lineLimit(1)]}
        >
          {pinnedProject?.title ?? brandName}
        </Text>
        <Spacer minLength={0} />
        <Text
          modifiers={[
            font({ weight: "semibold", size: 10.5 }),
            foregroundStyle(isStale ? secondaryFg : runningCount > 0 ? inputTint : okTint),
            padding({ horizontal: 8, vertical: 3 }),
            background(subtleBg, shapes.capsule({ roundedCornerStyle: "continuous" })),
            lineLimit(1),
          ]}
        >
          {isStale
            ? outOfDateText
            : runningCount > 0
              ? `${runningCount} ${activeWordText}`
              : allClearText}
        </Text>
      </HStack>

      <HStack spacing={6}>
        {renderActionPill("browne://talk-to-fleet", "waveform", talkShortText, "primary", true)}
        {renderActionPill(
          "browne://new/scratch",
          "square.and.pencil",
          quickShortText,
          "secondary",
          true,
        )}
        {renderActionPill("browne://new", "plus", newShortText, "secondary", true)}
      </HStack>

      <HStack spacing={6}>
        {renderStatTile(
          String(runningCount),
          runningLabelText,
          runningCount > 0 ? inputTint : undefined,
        )}
        {renderStatTile(String(doneTodayCount), doneTodayLabelText, okTint)}
        {renderStatTile(thirdStatValue, thirdStatLabel)}
      </HStack>

      {allowInteractiveTabs ? (
        <HStack
          spacing={3}
          modifiers={[
            padding({ all: 3 }),
            background(
              cardBg,
              shapes.roundedRectangle({ cornerRadius: 10, roundedCornerStyle: "continuous" }),
            ),
          ]}
        >
          {renderTabButton("latest", latestTabText)}
          {renderTabButton("running", runningTabText)}
          {renderTabButton("projects", projectsTabText)}
          {renderTabButton("fleet", fleetTabText)}
        </HStack>
      ) : null}

      {activeTab === "projects" && slideCount > 0 && activeProjectSlide ? (
        <HStack
          spacing={6}
          alignment="center"
          modifiers={[
            padding({ horizontal: 6, vertical: 4 }),
            background(
              cardBg,
              shapes.roundedRectangle({ cornerRadius: 10, roundedCornerStyle: "continuous" }),
            ),
          ]}
        >
          <Button
            onPress={() =>
              patchProps({
                activeTab: "projects",
                projectSlideIndex: (activeProjectSlideIndex - 1 + slideCount) % slideCount,
              })
            }
            modifiers={[buttonStyle("plain")]}
          >
            <HStack
              alignment="center"
              modifiers={[
                frame({ width: 24, height: 22, alignment: "center" }),
                background(
                  subtleBg,
                  shapes.roundedRectangle({ cornerRadius: 6, roundedCornerStyle: "continuous" }),
                ),
              ]}
            >
              <Image systemName="chevron.left" size={11} modifiers={[foregroundStyle(primaryFg)]} />
            </HStack>
          </Button>
          <Spacer minLength={0} />
          <VStack alignment="center" spacing={0}>
            <Text
              modifiers={[
                font({ weight: "bold", size: 12 }),
                foregroundStyle(primaryFg),
                lineLimit(1),
              ]}
            >
              {activeProjectSlide.title}
            </Text>
            {activeProjectSlide.environmentLabel ? (
              <Text modifiers={[font({ size: 9.5 }), foregroundStyle(secondaryFg), lineLimit(1)]}>
                {activeProjectSlide.environmentLabel}
              </Text>
            ) : null}
          </VStack>
          <Spacer minLength={0} />
          <Button
            onPress={() =>
              patchProps({
                activeTab: "projects",
                projectSlideIndex: (activeProjectSlideIndex + 1) % slideCount,
              })
            }
            modifiers={[buttonStyle("plain")]}
          >
            <HStack
              alignment="center"
              modifiers={[
                frame({ width: 24, height: 22, alignment: "center" }),
                background(
                  subtleBg,
                  shapes.roundedRectangle({ cornerRadius: 6, roundedCornerStyle: "continuous" }),
                ),
              ]}
            >
              <Image
                systemName="chevron.right"
                size={11}
                modifiers={[foregroundStyle(primaryFg)]}
              />
            </HStack>
          </Button>
        </HStack>
      ) : null}

      {activeTab === "fleet" ? (
        fleetItems.length > 0 ? (
          <VStack alignment="leading" spacing={5}>
            {fleetItems.slice(0, 3).map((item) => renderFleetRow(item, false))}
          </VStack>
        ) : (
          <Text modifiers={[font({ size: 11.5 }), foregroundStyle(secondaryFg), lineLimit(2)]}>
            {hasPublishedData ? noFleetText : openToSyncText}
          </Text>
        )
      ) : activeTopicsForLarge.length > 0 ? (
        <VStack alignment="leading" spacing={5}>
          {activeTopicsForLarge.map((row) =>
            renderTopicRow(row, true, activeTab !== "projects" && !pinnedProject),
          )}
        </VStack>
      ) : (
        <Text modifiers={[font({ size: 11.5 }), foregroundStyle(secondaryFg), lineLimit(2)]}>
          {!hasPublishedData
            ? openToSyncText
            : activeTab === "running"
              ? noRunningText
              : activeTab === "projects"
                ? allProjectsText
                : noTopicsText}
        </Text>
      )}

      <Spacer minLength={0} />
      <HStack spacing={6}>
        <Text modifiers={[font({ size: 10 }), foregroundStyle(secondaryFg), lineLimit(1)]}>
          {isStale
            ? staleHintText
            : stats && stats.totalEnvCount > 0
              ? `${stats.connectedEnvCount}/${stats.totalEnvCount}`
              : brandName}
        </Text>
        <Spacer minLength={0} />
        <Text modifiers={[font({ size: 10 }), foregroundStyle(secondaryFg), lineLimit(1)]}>
          {isStale ? outOfDateText : syncedLabelText}
        </Text>
      </HStack>
    </VStack>
  );
}

export default createWidget<Partial<BrowneHubSnapshot>, BrowneHubConfiguration>(
  "BrowneHub",
  BrowneHubWidget,
);
