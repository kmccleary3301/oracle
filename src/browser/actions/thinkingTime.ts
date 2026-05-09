import type { ChromeClient, BrowserLogger } from "../types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import { MENU_CONTAINER_SELECTOR, MENU_ITEM_SELECTOR } from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";

type ThinkingTimeOutcome =
  | { status: "already-selected"; label?: string | null }
  | { status: "switched"; label?: string | null }
  | { status: "chip-not-found"; diagnostics?: ThinkingControlsDiagnostics }
  | { status: "menu-not-found"; diagnostics?: ThinkingControlsDiagnostics }
  | { status: "option-not-found"; diagnostics?: ThinkingControlsDiagnostics };

export type ThinkingTimeSelectionStatus =
  | "selected"
  | "already-selected"
  | "unavailable"
  | "option-not-found"
  | "failed";

export interface ThinkingTimeSelectionResult {
  requestedThinkingTime: ThinkingTimeLevel;
  normalizedThinkingTime?: ThinkingTimeLevel;
  actualThinkingTime?: string | null;
  status: ThinkingTimeSelectionStatus;
  fallbackUsed: boolean;
  reason?: string;
  diagnostics?: ThinkingControlsDiagnostics;
}

export interface ThinkingControlInfo {
  label: string;
  selected: boolean;
  role?: string | null;
  testId?: string | null;
  ariaLabel?: string | null;
}

export interface ThinkingControlsDiagnostics {
  requestedThinkingTime?: ThinkingTimeLevel;
  normalizedThinkingTime?: ThinkingTimeLevel;
  chipCandidates: ThinkingControlInfo[];
  menuControls: ThinkingControlInfo[];
  availableOptions: string[];
}

/**
 * Selects a specific thinking time level in ChatGPT's composer pill menu.
 * @param level - The thinking time intensity: 'light', 'standard', 'extended', or 'heavy'
 */
export async function ensureThinkingTime(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
) {
  const result = await evaluateThinkingTimeSelection(Runtime, level);
  const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);

  switch (result?.status) {
    case "already-selected":
      logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
      return;
    case "switched":
      logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
      return;
    case "chip-not-found": {
      await logDomFailure(Runtime, logger, "thinking-chip");
      throw new Error("Unable to find the Thinking chip button in the composer area.");
    }
    case "menu-not-found": {
      await logDomFailure(Runtime, logger, "thinking-time-menu");
      throw new Error("Unable to find the Thinking time dropdown menu.");
    }
    case "option-not-found": {
      await logDomFailure(Runtime, logger, `${level}-option`);
      throw new Error(`Unable to find the ${capitalizedLevel} option in the Thinking time menu.`);
    }
    default: {
      await logDomFailure(Runtime, logger, "thinking-time-unknown");
      throw new Error(`Unknown error selecting ${capitalizedLevel} thinking time.`);
    }
  }
}

/**
 * Best-effort selection of a thinking time level in ChatGPT's composer pill menu.
 * Safe by default: if the pill/menu/option isn't present, we continue without throwing.
 * @param level - The thinking time intensity: 'light', 'standard', 'extended', or 'heavy'
 */
export async function ensureThinkingTimeIfAvailable(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
): Promise<ThinkingTimeSelectionResult> {
  const normalizedLevel = normalizeThinkingTimeLevel(level);
  try {
    const result = await evaluateThinkingTimeSelection(Runtime, level);
    const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);

    switch (result?.status) {
      case "already-selected":
        logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
        return {
          requestedThinkingTime: level,
          normalizedThinkingTime: normalizedLevel,
          actualThinkingTime: result.label ?? capitalizedLevel,
          status: "already-selected",
          fallbackUsed: false,
        };
      case "switched":
        logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
        return {
          requestedThinkingTime: level,
          normalizedThinkingTime: normalizedLevel,
          actualThinkingTime: result.label ?? capitalizedLevel,
          status: "selected",
          fallbackUsed: false,
        };
      case "chip-not-found":
      case "menu-not-found":
        if (logger.verbose) {
          logger(`Thinking time: ${result.status.replaceAll("-", " ")}; continuing with default.`);
        }
        return {
          requestedThinkingTime: level,
          normalizedThinkingTime: normalizedLevel,
          status: "unavailable",
          fallbackUsed: true,
          reason: result.status,
          diagnostics: result.diagnostics,
        };
      case "option-not-found":
        if (logger.verbose) {
          logger(`Thinking time: ${result.status.replaceAll("-", " ")}; continuing with default.`);
        }
        return {
          requestedThinkingTime: level,
          normalizedThinkingTime: normalizedLevel,
          status: "option-not-found",
          fallbackUsed: true,
          reason: result.status,
          diagnostics: result.diagnostics,
        };
      default:
        if (logger.verbose) {
          logger("Thinking time: unknown outcome; continuing with default.");
        }
        return {
          requestedThinkingTime: level,
          normalizedThinkingTime: normalizedLevel,
          status: "failed",
          fallbackUsed: true,
          reason: "unknown-outcome",
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger.verbose) {
      logger(`Thinking time selection failed (${message}); continuing with default.`);
      await logDomFailure(Runtime, logger, "thinking-time");
    }
    return {
      requestedThinkingTime: level,
      normalizedThinkingTime: normalizedLevel,
      status: "failed",
      fallbackUsed: true,
      reason: message,
    };
  }
}

export async function inspectThinkingControls(
  Runtime: ChromeClient["Runtime"],
  level?: ThinkingTimeLevel,
): Promise<ThinkingControlsDiagnostics> {
  const outcome = await Runtime.evaluate({
    expression: buildThinkingControlsInspectionExpression(level),
    awaitPromise: true,
    returnByValue: true,
  });
  const value = outcome.result?.value as Partial<ThinkingControlsDiagnostics> | undefined;
  return normalizeThinkingControlsDiagnostics(value, level);
}

async function evaluateThinkingTimeSelection(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
): Promise<ThinkingTimeOutcome | undefined> {
  const outcome = await Runtime.evaluate({
    expression: buildThinkingTimeExpression(level),
    awaitPromise: true,
    returnByValue: true,
  });

  return outcome.result?.value as ThinkingTimeOutcome | undefined;
}

function buildThinkingTimeExpression(level: ThinkingTimeLevel): string {
  const targetLevelLiteral = JSON.stringify(level.toLowerCase());

  return `(async () => {
    ${buildClickDispatcher()}
    ${buildThinkingControlsHelpers()}

    const TARGET_LEVEL = ${targetLevelLiteral};
    const NORMALIZED_TARGET_LEVEL = normalizeThinkingLevel(TARGET_LEVEL);
    const TARGET_ALIASES = thinkingLevelAliases(NORMALIZED_TARGET_LEVEL);

    const INITIAL_WAIT_MS = 150;
    const MAX_WAIT_MS = 10000;

    const chip = findThinkingChip();
    if (!chip) {
      return { status: 'chip-not-found', diagnostics: inspectThinkingControls(TARGET_LEVEL) };
    }

    dispatchClickSequence(chip);

    return new Promise((resolve) => {
      const start = performance.now();

      const findMenu = () => {
        const menus = document.querySelectorAll(MENU_CONTAINER_SELECTOR + ', [role="group"]');
        for (const menu of menus) {
          const label = menu.querySelector?.('.__menu-label, [class*="menu-label"], [aria-label]');
          if (normalize(label?.textContent ?? '').includes('thinking time')) {
            return menu;
          }
          const text = normalize(menu.textContent ?? '');
          if (
            (text.includes('standard') && (text.includes('extended') || text.includes('heavy'))) ||
            (text.includes('pro') && (text.includes('auto') || text.includes('thinking'))) ||
            (text.includes('think') && (text.includes('longer') || text.includes('harder') || text.includes('deep')))
          ) {
            return menu;
          }
        }
        return null;
      };

      const findTargetOption = (menu) => {
        const items = menu.querySelectorAll(MENU_ITEM_SELECTOR);
        for (const item of items) {
          const text = normalize(item.textContent ?? '');
          if (TARGET_ALIASES.some((alias) => text.includes(alias))) {
            return item;
          }
        }
        return null;
      };

      const optionIsSelected = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const ariaChecked = node.getAttribute('aria-checked');
        const dataState = (node.getAttribute('data-state') || '').toLowerCase();
        if (ariaChecked === 'true') return true;
        if (dataState === 'checked' || dataState === 'selected' || dataState === 'on') return true;
        return false;
      };

      const attempt = () => {
        const menu = findMenu();
        if (!menu) {
          if (performance.now() - start > MAX_WAIT_MS) {
            resolve({ status: 'menu-not-found', diagnostics: inspectThinkingControls(TARGET_LEVEL) });
            return;
          }
          setTimeout(attempt, 100);
          return;
        }

        const targetOption = findTargetOption(menu);
        if (!targetOption) {
          resolve({ status: 'option-not-found', diagnostics: inspectThinkingControls(TARGET_LEVEL) });
          return;
        }

        const alreadySelected =
          optionIsSelected(targetOption) ||
          optionIsSelected(targetOption.querySelector?.('[aria-checked="true"], [data-state="checked"], [data-state="selected"]'));
        const label = targetOption.textContent?.trim?.() || null;
        dispatchClickSequence(targetOption);
        resolve({ status: alreadySelected ? 'already-selected' : 'switched', label });
      };

      setTimeout(attempt, INITIAL_WAIT_MS);
    });
  })()`;
}

function buildThinkingControlsInspectionExpression(level?: ThinkingTimeLevel): string {
  const targetLevelLiteral = JSON.stringify(level?.toLowerCase() ?? null);
  return `(() => {
    ${buildThinkingControlsHelpers()}
    return inspectThinkingControls(${targetLevelLiteral});
  })()`;
}

function buildThinkingControlsHelpers(): string {
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  return `
    const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
    const MENU_ITEM_SELECTOR = ${menuItemLiteral};

    const CHIP_SELECTORS = [
      '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
      '[data-testid="composer-footer-actions"] button',
      'button.__composer-pill[aria-haspopup="menu"]',
      'button.__composer-pill',
      '.__composer-pill-composite button[aria-haspopup="menu"]',
      '.__composer-pill-composite button',
      'button[aria-haspopup="menu"]',
      '[role="button"][aria-haspopup="menu"]',
    ];

    const normalize = (value) => (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();

    const labelFor = (node) =>
      String(node?.innerText || node?.textContent || node?.getAttribute?.('aria-label') || '').trim();

    const controlInfo = (node) => {
      const label = labelFor(node);
      const ariaLabel = node?.getAttribute?.('aria-label') || null;
      const role = node?.getAttribute?.('role') || null;
      const testId = node?.getAttribute?.('data-testid') || null;
      const selected =
        node?.getAttribute?.('aria-checked') === 'true' ||
        node?.getAttribute?.('aria-selected') === 'true' ||
        ['checked', 'selected', 'on'].includes(String(node?.getAttribute?.('data-state') || '').toLowerCase());
      return { label, selected, role, testId, ariaLabel };
    };

    const uniqueControls = (nodes) => {
      const seen = new Set();
      const controls = [];
      for (const node of nodes) {
        const info = controlInfo(node);
        const signature = [normalize(info.label), normalize(info.ariaLabel), info.role || '', info.testId || ''].join('::');
        if (!signature.replace(/:/g, '').trim() || seen.has(signature)) continue;
        seen.add(signature);
        controls.push(info);
      }
      return controls;
    };

    const normalizeThinkingLevel = (level) => {
      const normalized = normalize(level);
      if (normalized === 'extended') return 'heavy';
      return normalized;
    };

    const thinkingLevelAliases = (level) => {
      const normalized = normalizeThinkingLevel(level);
      if (normalized === 'heavy') {
        return ['heavy', 'extended', 'deep', 'pro', 'longer', 'thorough', 'maximum'];
      }
      if (normalized === 'standard') {
        return ['standard', 'normal', 'auto', 'default'];
      }
      if (normalized === 'light') {
        return ['light', 'quick', 'fast'];
      }
      return [normalized].filter(Boolean);
    };

    const findThinkingChip = () => {
      const candidates = [];
      for (const selector of CHIP_SELECTORS) {
        candidates.push(...Array.from(document.querySelectorAll(selector)));
      }
      for (const btn of candidates) {
        const hasMenu = btn.getAttribute?.('aria-haspopup') === 'menu';
        const aria = normalize(btn.getAttribute?.('aria-label') ?? '');
        const text = normalize(btn.textContent ?? '');
        const testId = normalize(btn.getAttribute?.('data-testid') ?? '');
        const combined = [aria, text, testId].join(' ');
        if (!hasMenu && !combined.includes('thinking') && !combined.includes('pro')) continue;
        if (
          combined.includes('thinking') ||
          combined.includes('think') ||
          combined.includes('reasoning') ||
          combined.includes('pro')
        ) {
          return btn;
        }
      }
      return null;
    };

    const inspectThinkingControls = (requestedLevel) => {
      const chipNodes = [];
      for (const selector of CHIP_SELECTORS) {
        chipNodes.push(...Array.from(document.querySelectorAll(selector)));
      }
      const menuNodes = Array.from(document.querySelectorAll(MENU_ITEM_SELECTOR));
      const chipCandidates = uniqueControls(chipNodes).filter((info) => {
        const combined = normalize([info.label, info.ariaLabel, info.testId].filter(Boolean).join(' '));
        return (
          combined.includes('thinking') ||
          combined.includes('think') ||
          combined.includes('reasoning') ||
          combined.includes('pro')
        );
      });
      const menuControls = uniqueControls(menuNodes);
      const availableOptions = Array.from(new Set(menuControls.map((item) => item.label).filter(Boolean)));
      return {
        requestedThinkingTime: requestedLevel || undefined,
        normalizedThinkingTime: requestedLevel ? normalizeThinkingLevel(requestedLevel) : undefined,
        chipCandidates,
        menuControls,
        availableOptions,
      };
    };
  `;
}

function normalizeThinkingTimeLevel(level: ThinkingTimeLevel): ThinkingTimeLevel {
  return level === "extended" ? "heavy" : level;
}

function normalizeThinkingControlsDiagnostics(
  value: Partial<ThinkingControlsDiagnostics> | undefined,
  level?: ThinkingTimeLevel,
): ThinkingControlsDiagnostics {
  return {
    requestedThinkingTime: level,
    normalizedThinkingTime: level ? normalizeThinkingTimeLevel(level) : undefined,
    chipCandidates: Array.isArray(value?.chipCandidates) ? value.chipCandidates : [],
    menuControls: Array.isArray(value?.menuControls) ? value.menuControls : [],
    availableOptions: Array.isArray(value?.availableOptions)
      ? value.availableOptions.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export function buildThinkingTimeExpressionForTest(level: ThinkingTimeLevel = "extended"): string {
  return buildThinkingTimeExpression(level);
}
