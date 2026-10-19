import {
  ArchiveBoxIcon,
  ArrowRightIcon,
  ArrowUturnLeftIcon,
  ArrowUpIcon,
  BoltIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleStackIcon,
  CommandLineIcon,
  CubeTransparentIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  GlobeAltIcon,
  HomeIcon,
  MoonIcon,
  PaintBrushIcon,
  PaperClipIcon,
  PencilSquareIcon,
  PhotoIcon,
  PlusIcon,
  QuestionMarkCircleIcon,
  SparklesIcon,
  SunIcon,
  SwatchIcon,
  TrashIcon,
  UserCircleIcon,
  VideoCameraIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ElementType,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { BlobStorageMetadata } from './blob-store';
import SkillGallery from './SkillGallery';
import type { SkillLaunchDraft } from './skill-launch';
import './frontstage-skills.css';
import type { CreationMode, ImageProviderId, Theme } from './domain';
import {
  COMMUNITY_ITEMS,
  type CommunityItem,
  type PortalProjectSummary,
  type PortalRoute,
} from './portal-state';

export type FrontstageVideoProviderId = 'evolink-sora-2-preview';

export interface FrontstageStagedReference {
  assetId: string;
  width: number;
  height: number;
  storage: BlobStorageMetadata;
}

/**
 * Presentation-only project summary. Persistence, migration and storage
 * ownership stay in the Root repository; this component never reads project
 * records directly from localStorage or IndexedDB.
 */
export interface FrontstageProjectSummary {
  id: string;
  title: string;
  theme: Theme;
  objectCount: number;
  imageCount: number;
  videoCount: number;
  versionCount: number;
  updatedAt?: string;
  hasLocalContent: boolean;
  coverUrl?: string;
  coverKind?: 'image' | 'video';
  trashedAt?: string;
}

export type FrontstageAssetAvailability = 'available' | 'loading' | 'missing';

/** Safe view model for one immutable, project-owned local Asset. */
export interface FrontstageAssetSummary {
  id: string;
  projectId: string;
  title: string;
  kind: 'image' | 'video';
  mimeType: string;
  width: number;
  height: number;
  durationSeconds?: number;
  createdAt: string;
  sourceLabel: string;
  referenceCount: number;
  availability: FrontstageAssetAvailability;
  thumbnailUrl?: string;
  lineageLabel?: string;
}

export type ProductFrontstageRoute = PortalRoute | 'assets';
type FrontstageActionResult = void | boolean | Promise<void | boolean>;

/**
 * UI-owned DTO for the future portal-state handoff. The root layer adds the
 * handoff id, project id and five-minute expiry before persisting metadata.
 * No File/Blob or original filename is allowed in this value.
 */
export interface ProductFrontstageHandoffDraft {
  schemaVersion: 1;
  source: 'home-composer' | 'inspiration-preset';
  action: 'prefill';
  prompt: string;
  creationMode: CreationMode;
  imageProviderId: ImageProviderId;
  videoProviderId: FrontstageVideoProviderId;
  preset?: { id: string; category: CommunityItem['category'] };
  stagedReference?: FrontstageStagedReference;
  explicitSend: true;
}

export interface ProductFrontstageProps {
  route: ProductFrontstageRoute;
  theme: Theme;
  /** Legacy single-project value; kept while Root migrates to `projects`. */
  project: PortalProjectSummary;
  projects?: readonly FrontstageProjectSummary[];
  activeProjectId?: string;
  trashedProjects?: readonly FrontstageProjectSummary[];
  assets?: readonly FrontstageAssetSummary[];
  onNavigate: (route: PortalRoute) => void;
  onToggleTheme: () => void;
  onOpenWorkspace: () => void;
  onOpenAssetLibrary?: () => void;
  onCreateProject?: (title: string) => FrontstageActionResult;
  onOpenProject?: (projectId: string) => FrontstageActionResult;
  onRenameProject?: (projectId: string, title: string) => FrontstageActionResult;
  onMoveProjectToTrash?: (projectId: string) => FrontstageActionResult;
  onRestoreProject?: (projectId: string) => FrontstageActionResult;
  onAddAssetToCanvas?: (projectId: string, assetId: string) => FrontstageActionResult;
  /** Legacy prompt-only fallback retained while portal-state wiring migrates. */
  onUseInspiration: (prompt: string) => void;
  onSubmitHandoff?: (draft: ProductFrontstageHandoffDraft) => void | Promise<void>;
  /** Must validate, sanitize and put the image in IndexedDB before resolving. */
  onStageAttachment?: (file: File) => Promise<FrontstageStagedReference>;
  /** Gives the owner a chance to remove an abandoned staged Blob. */
  onDiscardStagedAttachment?: (reference: FrontstageStagedReference) => void | Promise<void>;
  isHandoffSubmitting?: boolean;
  onLaunchSkill?: (draft: SkillLaunchDraft) => Promise<void>;
}

type InspirationCategory = '全部' | CommunityItem['category'];
type ModelTab = CreationMode | '3d';

type AttachmentState =
  | { status: 'idle' }
  | { status: 'staging'; displayName: string; previous?: { displayName: string; reference: FrontstageStagedReference } }
  | { status: 'ready'; displayName: string; reference: FrontstageStagedReference }
  | { status: 'failed'; message: string };

const VIDEO_PROVIDER_ID: FrontstageVideoProviderId = 'evolink-sora-2-preview';

const INSPIRATION_CATEGORIES: readonly InspirationCategory[] = [
  '全部',
  '产品视觉',
  '品牌海报',
  '空间灵感',
];

const formatActivity = (value?: string): string => {
  if (!value) return '尚未开始创作';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '已有本地内容';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(time));
};

const modeLabel = (mode: CreationMode): string => {
  if (mode === 'image') return '图片';
  if (mode === 'video') return '视频';
  return 'Agent';
};

const modelLabel = (mode: CreationMode, imageProviderId: ImageProviderId): string => {
  if (mode === 'video') return '已配置的视频模型';
  if (mode === 'agent') return 'ELYRA Agent';
  if (imageProviderId === 'evolink-gpt-image-2') return '已配置的图片模型';
  return '本地确定性';
};

const ENTRY_STYLES = `
  .elyra-entry {
    --entry-bg: #111214;
    --entry-surface: #191a1d;
    --entry-surface-raised: #202125;
    --entry-soft: #282a2f;
    --entry-text: #f4f4f0;
    --entry-muted: #9a9c98;
    --entry-line: #34363b;
    --entry-accent: #c4ff35;
    --entry-accent-ink: #172000;
    min-height: 100dvh;
    color: var(--entry-text);
    background: var(--entry-bg);
  }
  .elyra-entry.theme-light {
    --entry-bg: #fbfbfa;
    --entry-surface: #ffffff;
    --entry-surface-raised: #f7f7f5;
    --entry-soft: #efefec;
    --entry-text: #191a19;
    --entry-muted: #858680;
    --entry-line: #dedfda;
    --entry-accent: #b8f51c;
    --entry-accent-ink: #233000;
  }
  .elyra-entry button,
  .elyra-entry textarea,
  .elyra-entry input { font: inherit; }
  .elyra-entry button { color: inherit; }
  .elyra-entry button:disabled { opacity: 1; }
  .elyra-entry button:focus-visible,
  .elyra-entry textarea:focus-visible,
  .elyra-entry input:focus-visible {
    outline: 2px solid var(--entry-accent);
    outline-offset: 3px;
  }
  .entry-rail {
    position: fixed;
    z-index: 40;
    inset: 0 auto 0 0;
    width: 50px;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 18px 0 14px;
    border-right: 1px solid var(--entry-line);
    background: var(--entry-surface);
  }
  .entry-rail-mark,
  .entry-rail-button {
    position: relative;
    display: grid;
    width: 40px;
    height: 40px;
    flex: 0 0 auto;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 11px;
    background: transparent;
  }
  .entry-rail-mark { margin-bottom: 18px; background: transparent; }
  .entry-rail-mark img { width: 25px; height: 22px; object-fit: contain; filter: invert(1); }
  .theme-light .entry-rail-mark img { filter: none; }
  .entry-rail-button { margin: 2px 0; color: var(--entry-muted); }
  .entry-rail-button:hover:not(:disabled),
  .entry-rail-button[aria-current='page'] { color: var(--entry-text); background: var(--entry-soft); }
  .entry-rail-button[aria-current='page']::before {
    content: '';
    position: absolute;
    left: -10px;
    width: 3px;
    height: 20px;
    border-radius: 3px;
    background: var(--entry-accent);
  }
  .entry-rail-button svg { width: 21px; height: 21px; }
  .entry-rail-button.entry-create { margin-bottom: 11px; color: var(--entry-accent-ink); background: var(--entry-accent); }
  .entry-rail-button.entry-future { color: var(--entry-muted); opacity: .42; cursor: not-allowed; }
  .entry-rail-divider { width: 28px; height: 1px; margin: 8px 0; background: var(--entry-line); }
  .entry-rail-spacer { flex: 1; }
  .entry-rail-tooltip {
    position: absolute;
    left: 44px;
    top: 50%;
    width: max-content;
    max-width: 190px;
    padding: 7px 9px;
    color: var(--entry-text);
    border: 1px solid var(--entry-line);
    border-radius: 7px;
    background: var(--entry-surface);
    box-shadow: 0 8px 24px rgba(0,0,0,.16);
    font-size: 11px;
    line-height: 1.25;
    pointer-events: none;
    opacity: 0;
    transform: translateY(-50%) translateX(-4px);
    transition: opacity .14s ease, transform .14s ease;
  }
  .entry-rail-button:hover .entry-rail-tooltip,
  .entry-rail-button:focus-visible .entry-rail-tooltip { opacity: 1; transform: translateY(-50%) translateX(0); }
  .entry-main {
    width: calc(100% - 50px);
    min-width: 0;
    margin-left: 50px;
    padding: 232px clamp(24px, 4.2vw, 60px) 92px;
  }
  .entry-main.entry-main-assets { padding-top: 54px; }
  .entry-intro { text-align: center; }
  .entry-wordmark {
    display: inline-flex;
    align-items: center;
    gap: 11px;
    margin: 0;
    font-size: clamp(27px, 2.1vw, 32px);
    line-height: 1;
    letter-spacing: -.035em;
  }
  .entry-wordmark .entry-tagline { font-weight: 650; letter-spacing: -.045em; }
  .entry-wordmark img { width: 34px; height: 31px; object-fit: contain; filter: invert(1); }
  .theme-light .entry-wordmark img { filter: none; }
  .entry-intro-copy { margin: 7px 0 0; color: var(--entry-muted); font-size: 14px; }
  .entry-composer-wrap { position: relative; width: min(610px, 100%); margin: 14px auto 0; text-align: left; }
  .entry-composer {
    position: relative;
    z-index: 4;
    padding: 12px 13px 10px;
    border: 1px solid var(--entry-line);
    border-radius: 22px;
    background: var(--entry-surface);
    box-shadow: 0 3px 10px rgba(0,0,0,.035);
  }
  .entry-composer:focus-within { border-color: var(--entry-muted); box-shadow: 0 3px 12px rgba(0,0,0,.06); }
  .elyra-entry .entry-composer textarea:focus-visible { outline: 0; }
  .entry-composer textarea {
    display: block;
    width: 100%;
    min-height: 46px;
    max-height: 138px;
    padding: 0 3px;
    color: var(--entry-text);
    border: 0;
    outline: 0;
    resize: vertical;
    background: transparent;
    font-size: 14px;
    line-height: 1.5;
  }
  .entry-composer textarea::placeholder { color: var(--entry-muted); }
  .entry-composer-footer { display: flex; min-width: 0; align-items: center; gap: 8px; padding-top: 5px; }
  .entry-square-button,
  .entry-send-button {
    display: grid;
    width: 30px;
    height: 30px;
    flex: 0 0 auto;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 10px;
  }
  .entry-square-button { color: var(--entry-text); background: transparent; }
  .entry-square-button:hover { background: var(--entry-soft); }
  .entry-square-button svg,
  .entry-send-button svg { width: 19px; height: 19px; }
  .entry-composer-spacer { flex: 1; }
  .entry-model-trigger {
    display: inline-flex;
    min-width: 0;
    height: 36px;
    align-items: center;
    gap: 7px;
    padding: 0 10px;
    color: var(--entry-muted);
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    font-size: 12px;
    font-weight: 700;
  }
  .entry-model-trigger:hover,
  .entry-model-trigger[aria-expanded='true'] { color: var(--entry-text); border-color: var(--entry-line); background: var(--entry-soft); }
  .entry-model-trigger svg { width: 17px; height: 17px; }
  .entry-model-trigger span { overflow: hidden; max-width: 142px; text-overflow: ellipsis; white-space: nowrap; }
  .entry-send-button { color: var(--entry-accent-ink); background: var(--entry-accent); }
  .entry-send-button:disabled { color: var(--entry-muted); background: var(--entry-soft); cursor: not-allowed; }
  .entry-attachment-chip {
    display: flex;
    min-width: 0;
    max-width: 245px;
    height: 34px;
    align-items: center;
    gap: 6px;
    padding: 0 7px 0 9px;
    color: var(--entry-text);
    border: 1px solid var(--entry-line);
    border-radius: 9px;
    background: var(--entry-surface-raised);
    font-size: 11px;
  }
  .entry-attachment-chip > svg { width: 15px; height: 15px; color: var(--entry-accent); }
  .entry-attachment-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entry-attachment-chip button { display: grid; width: 23px; height: 23px; flex: none; place-items: center; padding: 0; color: var(--entry-muted); border: 0; border-radius: 6px; background: transparent; }
  .entry-attachment-chip button:hover { color: var(--entry-text); background: var(--entry-soft); }
  .entry-attachment-chip button svg { width: 14px; height: 14px; }
  .entry-staging-label { color: var(--entry-muted); font-size: 11px; }
  .entry-error { margin: 9px 2px 0; color: #e56b73; font-size: 11px; line-height: 1.4; }
  .entry-menu {
    position: absolute;
    z-index: 20;
    padding: 7px;
    border: 1px solid var(--entry-line);
    border-radius: 13px;
    background: var(--entry-surface);
    box-shadow: 0 18px 44px rgba(0,0,0,.20);
  }
  .entry-plus-menu { left: 0; bottom: 52px; width: 232px; }
  .entry-plus-menu button {
    display: flex;
    width: 100%;
    min-height: 42px;
    align-items: center;
    gap: 10px;
    padding: 0 10px;
    color: var(--entry-text);
    border: 0;
    border-radius: 8px;
    background: transparent;
    text-align: left;
    font-size: 12px;
  }
  .entry-plus-menu button:hover:not(:disabled) { background: var(--entry-soft); }
  .entry-plus-menu button:disabled { color: var(--entry-muted); background: var(--entry-surface-raised); cursor: not-allowed; }
  .entry-plus-menu button svg { width: 18px; height: 18px; flex: none; }
  .entry-plus-menu small { margin-left: auto; font-size: 9px; font-weight: 800; }
  .entry-model-menu { right: 0; top: calc(100% + 10px); width: min(400px, calc(100vw - 112px)); padding: 13px; }
  .entry-model-heading { display: flex; align-items: center; justify-content: space-between; padding: 2px 3px 11px; }
  .entry-model-heading strong { font-size: 18px; }
  .entry-local-badge { color: var(--entry-muted); font-size: 10px; font-weight: 700; }
  .entry-model-tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; padding: 3px; border-radius: 9px; background: var(--entry-soft); }
  .entry-model-tabs button { min-height: 31px; padding: 0 8px; color: var(--entry-muted); border: 0; border-radius: 7px; background: transparent; font-size: 11px; font-weight: 750; }
  .entry-model-tabs button[aria-selected='true'] { color: var(--entry-text); background: var(--entry-surface); box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  .entry-model-tabs button:disabled { opacity: .46; cursor: not-allowed; }
  .entry-model-list { display: grid; gap: 5px; padding-top: 10px; }
  .entry-model-option {
    display: grid;
    width: 100%;
    grid-template-columns: 28px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: start;
    padding: 11px;
    color: var(--entry-text);
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    text-align: left;
  }
  .entry-model-option:hover:not(:disabled) { border-color: var(--entry-line); background: var(--entry-surface-raised); }
  .entry-model-option.is-selected { border-color: var(--entry-accent); background: var(--entry-surface-raised); }
  .entry-model-option:disabled { color: var(--entry-muted); background: var(--entry-surface-raised); cursor: not-allowed; }
  .entry-model-option > svg { width: 22px; height: 22px; }
  .entry-model-option strong { display: block; font-size: 12px; }
  .entry-model-option p { margin: 4px 0 0; color: var(--entry-muted); font-size: 10px; line-height: 1.45; }
  .entry-model-option small { padding: 4px 6px; color: var(--entry-muted); border-radius: 6px; background: var(--entry-soft); font-size: 9px; }
  .entry-model-boundary { margin: 10px 3px 1px; color: var(--entry-muted); font-size: 9px; line-height: 1.45; }
  .entry-mode-row,
  .entry-quick-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
  .entry-mode-row { margin-top: 17px; }
  .entry-quick-row { margin-top: 10px; }
  .entry-mode-button,
  .entry-quick-chip {
    display: inline-flex;
    min-height: 34px;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    color: var(--entry-muted);
    border: 1px solid var(--entry-line);
    border-radius: 999px;
    background: var(--entry-surface);
    font-size: 11px;
    font-weight: 700;
  }
  .entry-mode-button:hover,
  .entry-quick-chip:hover { color: var(--entry-text); background: var(--entry-soft); }
  .entry-mode-button.is-selected { color: var(--entry-text); border-color: var(--entry-accent); }
  .entry-mode-button svg,
  .entry-quick-chip svg { width: 15px; height: 15px; }
  .entry-section {
    width: min(1280px, 100%);
    margin: 36px auto 0;
    scroll-margin-top: 24px;
  }
  .entry-section-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 17px; }
  .entry-section-heading h2 { margin: 0; font-size: 19px; letter-spacing: -.02em; }
  .entry-section-heading p { margin: 0; color: var(--entry-muted); font-size: 11px; }
  .entry-project-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
  .entry-project-card,
  .entry-project-empty {
    min-height: 202px;
    overflow: hidden;
    border: 1px solid var(--entry-line);
    border-radius: 16px;
    background: var(--entry-surface);
  }
  .entry-project-card {
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 0;
    color: var(--entry-text);
    text-align: left;
  }
  .entry-project-card:hover { border-color: var(--entry-muted); transform: translateY(-1px); }
  .entry-project-open {
    display: flex;
    min-height: 202px;
    flex: 1;
    flex-direction: column;
    padding: 0;
    color: inherit;
    border: 0;
    background: transparent;
    text-align: left;
  }
  .entry-project-open:focus-visible { outline-offset: -3px; }
  .entry-project-cover { position: relative; height: 143px; min-height: 0; flex: 0 0 143px; overflow: hidden; background: var(--entry-soft); }
  .entry-project-cover img,
  .entry-project-cover video { display: block; width: 100%; height: 100%; object-fit: cover; }
  .entry-project-cover-empty { display: grid; width: 100%; height: 100%; place-items: center; color: var(--entry-muted); }
  .entry-project-cover-empty svg { width: 30px; height: 30px; }
  .entry-local-cover-label { position: absolute; left: 10px; bottom: 10px; padding: 5px 7px; color: #f5f5f1; border-radius: 6px; background: rgba(17,18,20,.76); font-size: 9px; }
  .entry-project-active-label { color: var(--entry-accent-ink); background: var(--entry-accent); }
  .entry-project-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; padding: 10px 11px 11px; }
  .entry-project-kicker { color: var(--entry-muted); font-size: 10px; font-weight: 800; letter-spacing: .08em; }
  .entry-project-copy h3 { overflow: hidden; margin: 5px 0 0; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
  .entry-project-copy p { display: none; }
  .entry-project-meta { display: flex; gap: 8px; margin-top: auto; padding-top: 7px; color: var(--entry-muted); font-size: 10px; }
  .entry-project-meta span:last-child { margin-left: auto; }
  .entry-project-meta svg { width: 13px; height: 13px; vertical-align: -2px; }
  .entry-project-menu-trigger {
    position: absolute;
    z-index: 3;
    top: 8px;
    right: 8px;
    display: grid;
    width: 29px;
    height: 29px;
    place-items: center;
    padding: 0;
    color: #f5f5f1;
    border: 1px solid rgba(255,255,255,.16);
    border-radius: 8px;
    background: rgba(17,18,20,.72);
    backdrop-filter: blur(8px);
  }
  .entry-project-menu-trigger svg { width: 17px; height: 17px; }
  .entry-project-menu-popover {
    position: absolute;
    z-index: 5;
    top: 41px;
    right: 8px;
    width: 154px;
    padding: 5px;
    border: 1px solid var(--entry-line);
    border-radius: 9px;
    background: var(--entry-surface);
    box-shadow: 0 16px 34px rgba(0,0,0,.20);
  }
  .entry-project-menu-popover button { display: flex; width: 100%; min-height: 34px; align-items: center; gap: 8px; padding: 0 9px; color: var(--entry-text); border: 0; border-radius: 6px; background: transparent; font-size: 11px; text-align: left; }
  .entry-project-menu-popover button:hover { background: var(--entry-soft); }
  .entry-project-menu-popover button:last-child { color: #db555e; }
  .entry-project-menu-popover svg { width: 15px; height: 15px; }
  .entry-project-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 15px;
    color: var(--entry-muted);
    border-style: dashed;
    text-align: center;
  }
  .entry-project-empty svg { width: 28px; height: 28px; }
  .entry-project-empty strong { margin-top: 10px; color: var(--entry-text); font-size: 11px; }
  .entry-project-empty p { max-width: 180px; margin: 6px 0 0; font-size: 11px; line-height: 1.45; }
  .entry-project-empty.entry-project-create { color: var(--entry-text); cursor: pointer; }
  .entry-project-empty.entry-project-create:hover { color: var(--entry-accent-ink); border-color: var(--entry-accent); background: var(--entry-accent); }
  .entry-project-empty.entry-project-create svg { color: inherit; }
  .entry-project-trash { margin-top: 16px; border: 1px solid var(--entry-line); border-radius: 13px; background: var(--entry-surface); }
  .entry-project-trash summary { display: flex; min-height: 44px; align-items: center; gap: 8px; padding: 0 14px; color: var(--entry-muted); cursor: pointer; font-size: 11px; font-weight: 760; list-style: none; }
  .entry-project-trash summary::-webkit-details-marker { display: none; }
  .entry-project-trash summary svg { width: 16px; height: 16px; }
  .entry-trash-list { display: grid; gap: 7px; padding: 0 10px 10px; }
  .entry-trash-row { display: flex; min-width: 0; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 9px; background: var(--entry-surface-raised); }
  .entry-trash-row > span { min-width: 0; flex: 1; }
  .entry-trash-row strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  .entry-trash-row small { display: block; margin-top: 3px; color: var(--entry-muted); font-size: 9px; }
  .entry-trash-row button { display: inline-flex; min-height: 31px; align-items: center; gap: 6px; padding: 0 9px; color: var(--entry-text); border: 1px solid var(--entry-line); border-radius: 7px; background: var(--entry-surface); font-size: 10px; font-weight: 760; }
  .entry-trash-row button:hover { border-color: var(--entry-accent); }
  .entry-trash-row button svg { width: 14px; height: 14px; }

  .entry-assets-view { min-height: calc(100dvh - 110px); margin-top: 0; }
  .entry-assets-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
  .entry-assets-header h1 { margin: 7px 0 0; font-size: clamp(32px, 4vw, 50px); letter-spacing: -.05em; }
  .entry-assets-header > div > p { margin: 9px 0 0; color: var(--entry-muted); font-size: 12px; }
  .entry-assets-project { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--entry-line); border-radius: 11px; background: var(--entry-surface); }
  .entry-assets-project svg { width: 20px; height: 20px; color: var(--entry-accent); }
  .entry-assets-project span { max-width: 250px; }
  .entry-assets-project strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  .entry-assets-project small { display: block; margin-top: 3px; color: var(--entry-muted); font-size: 9px; }
  .entry-assets-project button { min-height: 32px; padding: 0 10px; color: var(--entry-text); border: 1px solid var(--entry-line); border-radius: 7px; background: var(--entry-surface-raised); font-size: 10px; font-weight: 760; }
  .entry-assets-toolbar { display: flex; align-items: center; gap: 7px; margin: 28px 0 15px; }
  .entry-assets-toolbar button { min-height: 32px; padding: 0 12px; color: var(--entry-muted); border: 0; border-radius: 9px; background: transparent; font-size: 11px; font-weight: 720; }
  .entry-assets-toolbar button:hover,
  .entry-assets-toolbar button[aria-pressed='true'] { color: var(--entry-text); background: var(--entry-soft); }
  .entry-assets-toolbar span { margin-left: auto; color: var(--entry-muted); font-size: 10px; }
  .entry-asset-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
  .entry-asset-card { overflow: hidden; border: 1px solid var(--entry-line); border-radius: 15px; background: var(--entry-surface); }
  .entry-asset-card:hover { border-color: var(--entry-muted); }
  .entry-asset-preview { position: relative; display: grid; height: 154px; place-items: center; overflow: hidden; color: var(--entry-muted); background: var(--entry-soft); }
  .entry-asset-preview img,
  .entry-asset-preview video { display: block; width: 100%; height: 100%; object-fit: cover; }
  .entry-asset-preview > svg { width: 30px; height: 30px; }
  .entry-asset-kind { position: absolute; top: 9px; left: 9px; padding: 5px 7px; color: #f5f5f1; border-radius: 6px; background: rgba(17,18,20,.76); font-size: 9px; font-weight: 790; }
  .entry-asset-missing { color: #db555e; background: color-mix(in srgb, #db555e 8%, var(--entry-soft)); }
  .entry-asset-copy { padding: 11px; }
  .entry-asset-copy h3 { overflow: hidden; margin: 0; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .entry-asset-copy p { margin: 6px 0 0; color: var(--entry-muted); font-size: 9px; line-height: 1.45; }
  .entry-asset-meta { display: flex; flex-wrap: wrap; gap: 5px 8px; margin-top: 9px; color: var(--entry-muted); font-size: 9px; }
  .entry-asset-copy button { display: inline-flex; width: 100%; min-height: 34px; align-items: center; justify-content: center; gap: 6px; margin-top: 11px; color: var(--entry-accent-ink); border: 0; border-radius: 8px; background: var(--entry-accent); font-size: 10px; font-weight: 800; }
  .entry-asset-copy button:disabled { color: var(--entry-muted); background: var(--entry-soft); cursor: not-allowed; }
  .entry-asset-copy button svg { width: 14px; height: 14px; }
  .entry-assets-empty { grid-column: 1 / -1; min-height: 260px; display: grid; place-items: center; padding: 30px; color: var(--entry-muted); border: 1px dashed var(--entry-line); border-radius: 16px; background: var(--entry-surface); text-align: center; }
  .entry-assets-empty svg { width: 34px; height: 34px; margin: 0 auto; }
  .entry-assets-empty strong { display: block; margin-top: 12px; color: var(--entry-text); font-size: 13px; }
  .entry-assets-empty p { max-width: 420px; margin: 7px 0 0; font-size: 11px; line-height: 1.55; }

  .entry-dialog-backdrop { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(5,6,7,.58); backdrop-filter: blur(7px); }
  .entry-dialog { width: min(430px, 100%); padding: 20px; color: var(--entry-text); border: 1px solid var(--entry-line); border-radius: 16px; background: var(--entry-surface); box-shadow: 0 28px 80px rgba(0,0,0,.34); }
  .entry-dialog-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
  .entry-dialog-heading h2 { margin: 0; font-size: 20px; letter-spacing: -.025em; }
  .entry-dialog-heading p { margin: 6px 0 0; color: var(--entry-muted); font-size: 11px; line-height: 1.5; }
  .entry-dialog-close { display: grid; width: 30px; height: 30px; flex: none; place-items: center; padding: 0; color: var(--entry-muted); border: 0; border-radius: 8px; background: transparent; }
  .entry-dialog-close:hover { color: var(--entry-text); background: var(--entry-soft); }
  .entry-dialog-close svg { width: 18px; height: 18px; }
  .entry-dialog label { display: grid; gap: 7px; margin-top: 18px; color: var(--entry-muted); font-size: 10px; font-weight: 760; }
  .entry-dialog input { width: 100%; height: 42px; padding: 0 12px; color: var(--entry-text); border: 1px solid var(--entry-line); border-radius: 9px; outline: 0; background: var(--entry-surface-raised); font-size: 12px; }
  .entry-dialog input:focus { border-color: var(--entry-accent); }
  .entry-dialog-error { min-height: 15px; margin: 7px 0 0; color: #db555e; font-size: 10px; }
  .entry-dialog-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin-top: 18px; }
  .entry-dialog-stats span { padding: 10px; border: 1px solid var(--entry-line); border-radius: 9px; background: var(--entry-surface-raised); }
  .entry-dialog-stats small { display: block; color: var(--entry-muted); font-size: 9px; }
  .entry-dialog-stats strong { display: block; margin-top: 5px; font-size: 13px; }
  .entry-dialog-warning { margin: 14px 0 0; padding: 11px 12px; color: var(--entry-muted); border: 1px solid var(--entry-line); border-radius: 9px; background: var(--entry-surface-raised); font-size: 10px; line-height: 1.55; }
  .entry-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  .entry-dialog-actions button { min-height: 38px; padding: 0 14px; color: var(--entry-text); border: 1px solid var(--entry-line); border-radius: 9px; background: var(--entry-surface-raised); font-size: 11px; font-weight: 780; }
  .entry-dialog-actions button:last-child { color: var(--entry-accent-ink); border-color: var(--entry-accent); background: var(--entry-accent); }
  .entry-dialog-actions button.entry-danger-action { color: #fff; border-color: #c84750; background: #c84750; }
  .entry-dialog-actions button:disabled { opacity: .5; cursor: not-allowed; }
  .entry-inspiration { margin-top: 52px; padding-bottom: 420px; }
  .entry-category-row { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 16px; }
  .entry-category-row button {
    min-height: 32px;
    padding: 0 12px;
    color: var(--entry-muted);
    border: 0;
    border-radius: 9px;
    background: transparent;
    font-size: 11px;
  }
  .entry-category-row button:hover,
  .entry-category-row button[aria-pressed='true'] { color: var(--entry-text); background: var(--entry-soft); }
  .entry-template-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
  .entry-template-card {
    overflow: hidden;
    padding: 0;
    color: var(--entry-text);
    border: 1px solid var(--entry-line);
    border-top: 3px solid var(--template-accent);
    border-radius: 15px;
    background: var(--entry-surface);
    text-align: left;
  }
  .entry-template-card:hover { border-right-color: var(--entry-muted); border-bottom-color: var(--entry-muted); border-left-color: var(--entry-muted); transform: translateY(-2px); }
  .entry-template-card.is-selected { box-shadow: 0 0 0 2px var(--entry-accent); }
  .entry-template-card img { display: block; width: 100%; height: 174px; object-fit: cover; }
  .entry-template-copy { display: block; padding: 15px; }
  .entry-template-copy small { color: var(--entry-muted); font-size: 9px; font-weight: 800; letter-spacing: .06em; }
  .entry-template-copy h3 { margin: 7px 0 5px; font-size: 14px; }
  .entry-template-copy p { margin: 0; color: var(--entry-muted); font-size: 10px; line-height: 1.5; }
  .entry-template-action { display: inline-flex; align-items: center; gap: 5px; margin-top: 12px; color: var(--entry-text); font-size: 10px; font-weight: 800; }
  .entry-template-action svg { width: 13px; height: 13px; }
  .entry-local-note { margin: 18px 0 0; color: var(--entry-muted); font-size: 10px; line-height: 1.5; }
  @media (max-width: 920px) {
    .entry-main { padding-right: 24px; padding-left: 24px; }
    .entry-project-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .entry-project-empty { min-height: 124px; }
    .entry-template-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .entry-asset-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  @media (max-width: 640px) {
    .entry-rail { width: 54px; }
    .entry-rail-mark, .entry-rail-button { width: 36px; height: 36px; }
    .entry-rail-tooltip { display: none; }
    .entry-main { width: calc(100% - 54px); margin-left: 54px; padding: 46px 15px 68px; }
    .entry-wordmark { font-size: 25px; }
    .entry-composer-wrap { margin-top: 23px; }
    .entry-composer { border-radius: 17px; }
    .entry-model-trigger span { display: none; }
    .entry-model-menu { right: -3px; width: calc(100vw - 78px); }
    .entry-mode-button, .entry-quick-chip { min-height: 32px; padding: 0 9px; }
    .entry-project-cover { min-height: 126px; }
    .entry-project-copy { padding: 10px; }
    .entry-project-meta span:last-child { width: 100%; margin-left: 0; }
    .entry-template-grid { grid-template-columns: 1fr; }
    .entry-assets-header { align-items: flex-start; flex-direction: column; }
    .entry-assets-project { width: 100%; }
    .entry-assets-project span { max-width: none; flex: 1; }
    .entry-asset-grid { grid-template-columns: 1fr; }
  }
`;

interface RailItem {
  id: string;
  label: string;
  icon: ElementType;
  route?: Exclude<ProductFrontstageRoute, 'workspace'>;
  disabled?: boolean;
}

const RAIL_ITEMS: readonly RailItem[] = [
  { id: 'home', label: '首页', icon: HomeIcon, route: 'home' },
  { id: 'projects', label: '最近项目', icon: FolderIcon, route: 'projects' },
  { id: 'inspiration', label: '灵感发现', icon: SparklesIcon, route: 'community' },
  { id: 'assets', label: '资产库', icon: PhotoIcon, route: 'assets' },
  { id: 'brand', label: '品牌套件 · 未开放', icon: SwatchIcon, disabled: true },
  { id: 'profile', label: '个人空间 · 未开放', icon: UserCircleIcon, disabled: true },
];

function EntryRail({
  route,
  theme,
  onNavigate,
  onToggleTheme,
  onOpenAssets,
  onLogo,
  onCreate,
}: Pick<ProductFrontstageProps, 'route' | 'theme' | 'onNavigate' | 'onToggleTheme'> & {
  onOpenAssets: () => void;
  onLogo: () => void;
  onCreate: () => void;
}) {
  const visibleRoute = route === 'workspace' ? 'home' : route;
  return (
    <aside className="entry-rail" aria-label="ELYRA 导航" data-testid="frontstage-rail">
      <button className="entry-rail-mark" type="button" onClick={onLogo} aria-label="返回 ELYRA 创作入口">
        <img src="/assets/elyra-mark.svg" alt="" aria-hidden="true" />
      </button>
      <button className="entry-rail-button entry-create" type="button" onClick={onCreate} aria-label="新建本地项目">
        <PlusIcon />
        <span className="entry-rail-tooltip">新建项目</span>
      </button>
      {RAIL_ITEMS.map((item, index) => {
        const Icon = item.icon;
        return (
          <div key={item.id}>
            {index === 3 ? <div className="entry-rail-divider" aria-hidden="true" /> : null}
            <button
              className={`entry-rail-button${item.disabled ? ' entry-future' : ''}`}
              type="button"
              disabled={item.disabled}
              aria-current={item.route === visibleRoute ? 'page' : undefined}
              aria-label={item.label}
              data-capability={item.id}
              onClick={() => {
                if (item.route === 'assets') onOpenAssets();
                else if (item.route) onNavigate(item.route);
              }}
            >
              <Icon />
              <span className="entry-rail-tooltip">{item.label}</span>
            </button>
          </div>
        );
      })}
      <div className="entry-rail-spacer" />
      <button
        className="entry-rail-button entry-future"
        type="button"
        disabled
        aria-label="帮助中心 · 未开放"
        data-capability="help"
      >
        <QuestionMarkCircleIcon />
        <span className="entry-rail-tooltip">帮助中心 · 未开放</span>
      </button>
      <button className="entry-rail-button" type="button" onClick={onToggleTheme} aria-label="切换日间或夜间主题">
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        <span className="entry-rail-tooltip">{theme === 'dark' ? '切换日间主题' : '切换夜间主题'}</span>
      </button>
    </aside>
  );
}

function ModeIcon({ mode }: { mode: CreationMode }) {
  if (mode === 'image') return <PhotoIcon />;
  if (mode === 'video') return <VideoCameraIcon />;
  return <SparklesIcon />;
}

function ModelMenu({
  activeTab,
  creationMode,
  imageProviderId,
  onTabChange,
  onSelectAgent,
  onSelectImage,
  onSelectLocalImage,
  onSelectVideo,
}: {
  activeTab: ModelTab;
  creationMode: CreationMode;
  imageProviderId: ImageProviderId;
  onTabChange: (tab: ModelTab) => void;
  onSelectAgent: () => void;
  onSelectImage: () => void;
  onSelectLocalImage: () => void;
  onSelectVideo: () => void;
}) {
  return (
    <div className="entry-menu entry-model-menu" role="dialog" aria-label="选择入口模式与模型" data-testid="frontstage-model-menu">
      <div className="entry-model-heading">
        <strong>模型</strong>
        <span className="entry-local-badge">首页仅预填 · 0 调用</span>
      </div>
      <div className="entry-model-tabs" role="tablist" aria-label="模型类型">
        {(['agent', 'image', 'video'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => onTabChange(tab)}
          >
            {modeLabel(tab)}
          </button>
        ))}
        <button type="button" role="tab" aria-selected="false" disabled aria-label="3D · 未开放">3D · 未开放</button>
      </div>
      <div className="entry-model-list">
        {activeTab === 'agent' ? (
          <>
            <button
              className={`entry-model-option${creationMode === 'agent' && imageProviderId === 'evolink-gpt-image-2' ? ' is-selected' : ''}`}
              type="button"
              onClick={onSelectAgent}
              data-model-id="evolink-agent-planner"
            >
              <CommandLineIcon />
              <span><strong>EvoLink Agent Planner</strong><p>首页只预填；进入工作台并主动发送后，才按既有授权与预算调用。</p></span>
              {creationMode === 'agent' && imageProviderId === 'evolink-gpt-image-2' ? <CheckIcon /> : <small>已接入</small>}
            </button>
            <button className="entry-model-option" type="button" disabled data-model-id="future-agent-models">
              <GlobeAltIcon />
              <span><strong>联网搜索与多模型 Agent</strong><p>搜索工具和其他远端模型尚未接入。</p></span>
              <small>未开放</small>
            </button>
          </>
        ) : null}
        {activeTab === 'image' ? (
          <>
            <button
              className={`entry-model-option${creationMode === 'image' && imageProviderId === 'evolink-gpt-image-2' ? ' is-selected' : ''}`}
              type="button"
              onClick={onSelectImage}
              data-model-id="evolink-gpt-image-2"
            >
              <PhotoIcon />
              <span><strong>GPT Image 2</strong><p>现有工作台图片入口；首页只预填，不自动生成。</p></span>
              {creationMode === 'image' && imageProviderId === 'evolink-gpt-image-2' ? <CheckIcon /> : <small>已接入</small>}
            </button>
            <button
              className={`entry-model-option${creationMode === 'image' && imageProviderId === 'deterministic-mock' ? ' is-selected' : ''}`}
              type="button"
              onClick={onSelectLocalImage}
              data-model-id="deterministic-mock"
            >
              <CommandLineIcon />
              <span><strong>本地确定性</strong><p>已接入的零费用本地模式，用于可重复测试。</p></span>
              {creationMode === 'image' && imageProviderId === 'deterministic-mock' ? <CheckIcon /> : <small>已接入</small>}
            </button>
            <button className="entry-model-option" type="button" disabled data-model-id="future-image-model">
              <CircleStackIcon />
              <span><strong>更多图片模型</strong><p>当前阶段没有接入其他图片模型。</p></span>
              <small>未开放</small>
            </button>
          </>
        ) : null}
        {activeTab === 'video' ? (
          <>
            <button
              className={`entry-model-option${creationMode === 'video' ? ' is-selected' : ''}`}
              type="button"
              onClick={onSelectVideo}
              data-model-id={VIDEO_PROVIDER_ID}
            >
              <VideoCameraIcon />
              <span><strong>Sora 2 Preview</strong><p>现有受控图生视频入口；进入工作台后仍需参考图与主动发送。</p></span>
              {creationMode === 'video' ? <CheckIcon /> : <small>已接入</small>}
            </button>
            <button className="entry-model-option" type="button" disabled data-model-id="text-to-video-unavailable">
              <BoltIcon />
              <span><strong>文本直接生成视频</strong><p>现有链路只允许受控图生视频。</p></span>
              <small>未开放</small>
            </button>
          </>
        ) : null}
      </div>
      <p className="entry-model-boundary">选择只写入一次性本地 handoff；不会在首页读取 Key、调用 Planner 或提交 Provider。</p>
    </div>
  );
}

type ProjectDialogState =
  | { mode: 'create' }
  | { mode: 'rename'; project: FrontstageProjectSummary }
  | { mode: 'trash'; project: FrontstageProjectSummary };

const nextUntitledProjectName = (projects: readonly FrontstageProjectSummary[]) => {
  const names = new Set(projects.map((project) => project.title.trim()));
  let suffix = 1;
  while (names.has(`未命名项目 ${suffix}`)) suffix += 1;
  return `未命名项目 ${suffix}`;
};

const runFrontstageAction = async (action?: () => FrontstageActionResult) => {
  if (!action) throw new Error('该本地项目操作尚未接线。');
  const result = await action();
  if (result === false) throw new Error('操作未完成，请重试。');
};

function ProjectNameDialog({
  mode,
  initialTitle,
  onCancel,
  onConfirm,
}: {
  mode: 'create' | 'rename';
  initialTitle: string;
  onCancel: () => void;
  onConfirm: (title: string) => FrontstageActionResult;
}) {
  const titleId = useId();
  const inputId = useId();
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = title.trim().replace(/\s+/g, ' ');
    if (!normalized) { setError('项目名称不能为空。'); return; }
    if (normalized.length > 80) { setError('项目名称最多 80 个字符。'); return; }
    setBusy(true);
    setError('');
    try {
      await runFrontstageAction(() => onConfirm(normalized));
      onCancel();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '项目操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="entry-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <form className="entry-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onCancel(); }} data-testid={mode === 'create' ? 'create-project-dialog' : 'rename-project-dialog'}>
        <div className="entry-dialog-heading">
          <div><h2 id={titleId}>{mode === 'create' ? '新建本地项目' : '重命名项目'}</h2><p>{mode === 'create' ? '新项目会拥有独立画布、资产和本地状态。' : '只修改当前项目名称，不影响画布与素材。'}</p></div>
          <button className="entry-dialog-close" type="button" onClick={onCancel} disabled={busy} aria-label="关闭"><XMarkIcon /></button>
        </div>
        <label htmlFor={inputId}>项目名称<input ref={inputRef} id={inputId} value={title} maxLength={80} onChange={(event) => { setTitle(event.target.value); setError(''); }} aria-invalid={Boolean(error)} aria-describedby={`${inputId}-error`} data-testid="project-name-input" /></label>
        <p className="entry-dialog-error" id={`${inputId}-error`} role={error ? 'alert' : undefined}>{error}</p>
        <div className="entry-dialog-actions"><button type="button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" disabled={busy}>{busy ? '保存中…' : mode === 'create' ? '创建项目' : '保存名称'}</button></div>
      </form>
    </div>
  );
}

function MoveToTrashDialog({ project, onCancel, onConfirm }: {
  project: FrontstageProjectSummary;
  onCancel: () => void;
  onConfirm: () => FrontstageActionResult;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);
  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await runFrontstageAction(onConfirm);
      onCancel();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '项目未能移到废纸篓，请重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="entry-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section className="entry-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onCancel(); }} data-testid="trash-project-dialog">
        <div className="entry-dialog-heading">
          <div><h2 id={titleId}>移到废纸篓？</h2><p>「{project.title}」会从最近项目隐藏，但仍可恢复。</p></div>
          <button className="entry-dialog-close" type="button" onClick={onCancel} disabled={busy} aria-label="关闭"><XMarkIcon /></button>
        </div>
        <div className="entry-dialog-stats"><span><small>对象</small><strong>{project.objectCount}</strong></span><span><small>资产</small><strong>{project.imageCount + project.videoCount}</strong></span><span><small>版本</small><strong>{project.versionCount}</strong></span></div>
        <p className="entry-dialog-warning" id={descriptionId}>这是可恢复操作：本地项目元数据与 IndexedDB 素材不会被永久清除，当前阶段也不提供永久删除。</p>
        {error ? <p className="entry-dialog-error" role="alert">{error}</p> : null}
        <div className="entry-dialog-actions"><button ref={cancelButtonRef} type="button" onClick={onCancel} disabled={busy}>取消</button><button className="entry-danger-action" type="button" onClick={() => void confirm()} disabled={busy}>{busy ? '移动中…' : '移到废纸篓'}</button></div>
      </section>
    </div>
  );
}

function ProjectCover({ project }: { project: FrontstageProjectSummary }) {
  if (project.coverUrl && project.coverKind === 'video') return <video src={project.coverUrl} muted playsInline preload="metadata" aria-label={`${project.title}视频封面`} />;
  if (project.coverUrl) return <img src={project.coverUrl} alt={`${project.title}项目封面`} />;
  return <span className="entry-project-cover-empty" aria-hidden="true"><PhotoIcon /></span>;
}

function RecentProjects({
  projects,
  activeProjectId,
  trashedProjects,
  onOpenProject,
  onCreateRequest,
  onRenameRequest,
  onTrashRequest,
  onRestoreProject,
  sectionRef,
}: {
  projects: readonly FrontstageProjectSummary[];
  activeProjectId?: string;
  trashedProjects: readonly FrontstageProjectSummary[];
  onOpenProject: (projectId: string) => FrontstageActionResult;
  onCreateRequest: () => void;
  onRenameRequest: (project: FrontstageProjectSummary) => void;
  onTrashRequest: (project: FrontstageProjectSummary) => void;
  onRestoreProject?: (projectId: string) => FrontstageActionResult;
  sectionRef: React.RefObject<HTMLElement | null>;
}) {
  const [menuProjectId, setMenuProjectId] = useState<string>();
  const [restoringId, setRestoringId] = useState<string>();
  const [restoreError, setRestoreError] = useState('');

  useEffect(() => {
    if (!menuProjectId) return;
    const close = () => setMenuProjectId(undefined);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuProjectId]);

  const restore = async (projectId: string) => {
    setRestoringId(projectId);
    setRestoreError('');
    try {
      await runFrontstageAction(onRestoreProject ? () => onRestoreProject(projectId) : undefined);
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : '项目恢复失败，请重试。');
    } finally {
      setRestoringId(undefined);
    }
  };

  return (
    <section className="entry-section" ref={sectionRef} aria-labelledby="recent-projects-heading" data-testid="frontstage-projects">
      <div className="entry-section-heading">
        <h2 id="recent-projects-heading">最近项目</h2>
        <p>{projects.length} 个本地项目 · 不进行云同步</p>
      </div>
      <div className="entry-project-grid">
        {projects.map((project) => {
          const active = project.id === activeProjectId;
          const menuOpen = menuProjectId === project.id;
          return <article className="entry-project-card" key={project.id} data-project-id={project.id} data-testid="local-project-card">
            <button className="entry-project-open" type="button" onClick={() => void onOpenProject(project.id)} aria-label={`打开项目：${project.title}`}>
              <span className="entry-project-cover"><ProjectCover project={project} /><span className={`entry-local-cover-label${active ? ' entry-project-active-label' : ''}`}>{active ? '当前项目' : '本机项目'}</span></span>
              <span className="entry-project-copy">
                <span className="entry-project-kicker">{project.imageCount} 张图片 · {project.videoCount} 个视频</span>
                <h3>{project.title}</h3>
                <p>{project.hasLocalContent ? '继续处理已保存在本机的画布内容。' : '空白本地项目。'}</p>
                <span className="entry-project-meta"><span>{project.objectCount} 个对象</span><span>{project.versionCount} 个版本</span><span>{formatActivity(project.updatedAt)} <ArrowRightIcon /></span></span>
              </span>
            </button>
            <button className="entry-project-menu-trigger" type="button" aria-label={`${project.title}项目操作`} aria-expanded={menuOpen} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setMenuProjectId((value) => value === project.id ? undefined : project.id); }}><EllipsisHorizontalIcon /></button>
            {menuOpen ? <div className="entry-project-menu-popover" role="menu" onPointerDown={(event) => event.stopPropagation()}>
              <button type="button" role="menuitem" onClick={() => { setMenuProjectId(undefined); onRenameRequest(project); }}><PencilSquareIcon />重命名</button>
              <button type="button" role="menuitem" onClick={() => { setMenuProjectId(undefined); onTrashRequest(project); }}><TrashIcon />移到废纸篓</button>
            </div> : null}
          </article>;
        })}
        <button className="entry-project-empty entry-project-create" type="button" onClick={onCreateRequest} data-testid="create-project-card"><PlusIcon /><strong>新建本地项目</strong><p>创建独立画布、资产和版本空间。</p></button>
      </div>
      {trashedProjects.length ? <details className="entry-project-trash" data-testid="project-trash">
        <summary><ArchiveBoxIcon />废纸篓 · {trashedProjects.length} 个可恢复项目</summary>
        <div className="entry-trash-list">
          {trashedProjects.map((project) => <div className="entry-trash-row" key={project.id}><span><strong>{project.title}</strong><small>{project.objectCount} 个对象 · {project.imageCount + project.videoCount} 个资产 · {formatActivity(project.trashedAt)}</small></span><button type="button" disabled={restoringId === project.id} onClick={() => void restore(project.id)}><ArrowUturnLeftIcon />{restoringId === project.id ? '恢复中…' : '恢复项目'}</button></div>)}
          {restoreError ? <p className="entry-dialog-error" role="alert">{restoreError}</p> : null}
          <p className="entry-local-note">当前阶段不提供永久清除；恢复会保留原 Canvas Object、Asset、Version 与 Blob。</p>
        </div>
      </details> : null}
    </section>
  );
}

function AssetLibrarySection({
  project,
  assets,
  onOpenProject,
  onAddAssetToCanvas,
}: {
  project?: FrontstageProjectSummary;
  assets: readonly FrontstageAssetSummary[];
  onOpenProject: (projectId: string) => FrontstageActionResult;
  onAddAssetToCanvas?: (projectId: string, assetId: string) => FrontstageActionResult;
}) {
  const [filter, setFilter] = useState<'all' | 'image' | 'video'>('all');
  const [addingId, setAddingId] = useState<string>();
  const [error, setError] = useState('');
  const projectAssets = useMemo(() => project ? assets.filter((asset) => asset.projectId === project.id) : [], [assets, project]);
  const visibleAssets = filter === 'all' ? projectAssets : projectAssets.filter((asset) => asset.kind === filter);

  const addAsset = async (asset: FrontstageAssetSummary) => {
    if (!project || asset.availability !== 'available') return;
    setAddingId(asset.id);
    setError('');
    try {
      await runFrontstageAction(onAddAssetToCanvas ? () => onAddAssetToCanvas(project.id, asset.id) : undefined);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '资产未能添加到画布，请重试。');
    } finally {
      setAddingId(undefined);
    }
  };

  return <section className="entry-section entry-assets-view" aria-labelledby="asset-library-heading" data-testid="frontstage-assets">
    <div className="entry-assets-header">
      <div><p className="entry-demo-label">LOCAL ASSET LIBRARY</p><h1 id="asset-library-heading">资产库</h1><p>仅显示当前项目已经落到本机的真实图片与视频，不包含云端素材。</p></div>
      {project ? <div className="entry-assets-project"><FolderIcon /><span><strong>{project.title}</strong><small>{projectAssets.length} 个本地资产 · {project.objectCount} 个画布对象</small></span><button type="button" onClick={() => void onOpenProject(project.id)}>打开画布</button></div> : null}
    </div>
    <div className="entry-assets-toolbar" role="group" aria-label="资产类型筛选">
      {([['all', '全部'], ['image', '图片'], ['video', '视频']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
      <span>{visibleAssets.length} / {projectAssets.length}</span>
    </div>
    {error ? <p className="entry-dialog-error" role="alert">{error}</p> : null}
    <div className="entry-asset-grid">
      {!project ? <div className="entry-assets-empty"><div><FolderIcon /><strong>没有可用项目</strong><p>先新建或恢复一个本地项目，再管理它的资产。</p></div></div> : null}
      {project && !visibleAssets.length ? <div className="entry-assets-empty"><div><PhotoIcon /><strong>{projectAssets.length ? '该筛选下没有资产' : '当前项目还没有本地资产'}</strong><p>{projectAssets.length ? '切换到“全部”查看其他类型。' : '生成、上传或保存到本机的图片与视频会出现在这里。'}</p></div></div> : null}
      {visibleAssets.map((asset) => {
        const available = asset.availability === 'available';
        const hasPreview = available && Boolean(asset.thumbnailUrl);
        const availabilityLabel = asset.availability === 'missing' ? '本地素材不可用' : asset.availability === 'loading' ? '正在恢复本地素材' : '本地可用';
        return <article className="entry-asset-card" key={asset.id} data-asset-id={asset.id} data-testid="asset-library-card">
          <div className={`entry-asset-preview${asset.availability === 'missing' ? ' entry-asset-missing' : ''}`}>
            {hasPreview && asset.kind === 'video' ? <video src={asset.thumbnailUrl} muted playsInline preload="metadata" aria-label={`${asset.title}视频预览`} /> : null}
            {hasPreview && asset.kind === 'image' ? <img src={asset.thumbnailUrl} alt={`${asset.title}缩略图`} /> : null}
            {!hasPreview ? asset.availability === 'missing' ? <ExclamationTriangleIcon /> : asset.kind === 'video' ? <VideoCameraIcon /> : <PhotoIcon /> : null}
            <span className="entry-asset-kind">{asset.kind === 'video' ? '视频' : '图片'}</span>
          </div>
          <div className="entry-asset-copy"><h3>{asset.title}</h3><p>{asset.sourceLabel}{asset.lineageLabel ? ` · ${asset.lineageLabel}` : ''}</p><div className="entry-asset-meta"><span>{asset.width} × {asset.height}</span>{asset.durationSeconds ? <span>{asset.durationSeconds.toFixed(1)}s</span> : null}<span>引用 {asset.referenceCount}</span><span>{availabilityLabel}</span></div><button type="button" disabled={!available || addingId === asset.id} onClick={() => void addAsset(asset)} data-testid="add-asset-to-canvas"><PlusIcon />{addingId === asset.id ? '添加中…' : available ? '添加到当前画布' : availabilityLabel}</button></div>
        </article>;
      })}
    </div>
    <p className="entry-local-note">添加到画布只创建新的 Canvas Object 与 Version；底层 Asset 和 IndexedDB Blob 保持唯一，不跨项目复制。</p>
  </section>;
}

function InspirationSection({
  category,
  selectedTemplateId,
  onCategoryChange,
  onSelectTemplate,
  sectionRef,
}: {
  category: InspirationCategory;
  selectedTemplateId?: string;
  onCategoryChange: (category: InspirationCategory) => void;
  onSelectTemplate: (item: CommunityItem) => void;
  sectionRef: React.RefObject<HTMLElement | null>;
}) {
  const visibleItems = useMemo(
    () => category === '全部' ? COMMUNITY_ITEMS : COMMUNITY_ITEMS.filter((item) => item.category === category),
    [category],
  );
  return (
    <section className="entry-section entry-inspiration" ref={sectionRef} aria-labelledby="inspiration-heading" data-testid="frontstage-inspiration">
      <div className="entry-section-heading">
        <h2 id="inspiration-heading">灵感发现</h2>
        <p>固定本地模板 · 选择后只预填</p>
      </div>
      <div className="entry-category-row" aria-label="灵感分类">
        {INSPIRATION_CATEGORIES.map((item) => (
          <button key={item} type="button" aria-pressed={category === item} onClick={() => onCategoryChange(item)}>{item}</button>
        ))}
      </div>
      <div className="entry-template-grid">
        {visibleItems.map((item) => (
          <button
            key={item.id}
            className={`entry-template-card${selectedTemplateId === item.id ? ' is-selected' : ''}`}
            type="button"
            aria-pressed={selectedTemplateId === item.id}
            onClick={() => onSelectTemplate(item)}
            style={{ '--template-accent': item.accent } as CSSProperties}
            data-testid={`inspiration-template-${item.id}`}
          >
            <img src="/assets/elyra-speaker.png" alt={`${item.title}本地模板预览`} />
            <span className="entry-template-copy">
              <small>{item.category} · ELYRA 本地模板</small>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <span className="entry-template-action">填入 Prompt <ArrowRightIcon /></span>
            </span>
          </button>
        ))}
      </div>
      <p className="entry-local-note">这里没有远端 Feed、真实用户或社交互动。浏览、分类和预填均不会产生外部请求或 Provider 调用。</p>
    </section>
  );
}

export default function ProductFrontstage(props: ProductFrontstageProps) {
  const {
    route,
    theme,
    project,
    projects: providedProjects,
    activeProjectId: providedActiveProjectId,
    trashedProjects = [],
    assets = [],
    onNavigate,
    onToggleTheme,
    onOpenWorkspace,
    onOpenAssetLibrary,
    onCreateProject,
    onOpenProject,
    onRenameProject,
    onMoveProjectToTrash,
    onRestoreProject,
    onAddAssetToCanvas,
    onUseInspiration,
    onSubmitHandoff,
    onStageAttachment,
    onDiscardStagedAttachment,
    isHandoffSubmitting = false,
  } = props;
  const [prompt, setPrompt] = useState('');
  const [creationMode, setCreationMode] = useState<CreationMode>('agent');
  const [imageProviderId, setImageProviderId] = useState<ImageProviderId>('evolink-gpt-image-2');
  const [selectedTemplate, setSelectedTemplate] = useState<CommunityItem>();
  const [category, setCategory] = useState<InspirationCategory>('全部');
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelTab, setModelTab] = useState<ModelTab>('agent');
  const [attachment, setAttachment] = useState<AttachmentState>({ status: 'idle' });
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState>();
  const submitLockRef = useRef(false);
  const composerRegionRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<AttachmentState>(attachment);
  const mountedRef = useRef(true);
  const handoffOwnsAttachmentRef = useRef(false);
  const projectSectionRef = useRef<HTMLElement>(null);
  const inspirationSectionRef = useRef<HTMLElement>(null);
  const submitting = isHandoffSubmitting || localSubmitting;
  const hasPrompt = prompt.trim().length > 0;
  const isAttachmentBusy = attachment.status === 'staging';
  const projects = useMemo<readonly FrontstageProjectSummary[]>(
    () => providedProjects?.length ? providedProjects : [project],
    [project, providedProjects],
  );
  const activeProjectId = providedActiveProjectId ?? project.id;
  const activeProject = projects.find((item) => item.id === activeProjectId) ?? projects[0] ?? project;

  const openProject = useCallback((projectId: string): FrontstageActionResult => {
    if (onOpenProject) return onOpenProject(projectId);
    if (projectId === project.id) return onOpenWorkspace();
    return false;
  }, [onOpenProject, onOpenWorkspace, project.id]);

  useEffect(() => {
    attachmentRef.current = attachment;
  }, [attachment]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const current = attachmentRef.current;
      const abandonedReference = current.status === 'ready'
        ? current.reference
        : current.status === 'staging' ? current.previous?.reference : undefined;
      if (abandonedReference && !handoffOwnsAttachmentRef.current && onDiscardStagedAttachment) {
        void Promise.resolve(onDiscardStagedAttachment(abandonedReference)).catch(() => undefined);
      }
    };
  }, [onDiscardStagedAttachment]);

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      if (!composerRegionRef.current?.contains(event.target as Node)) {
        setPlusMenuOpen(false);
        setModelMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeMenus);
    return () => document.removeEventListener('pointerdown', closeMenus);
  }, []);

  useEffect(() => {
    if (route === 'home' || route === 'assets') {
      const frame = window.requestAnimationFrame(() => window.scrollTo({ top: 0 }));
      return () => window.cancelAnimationFrame(frame);
    }
    const target = route === 'projects' ? projectSectionRef.current : route === 'community' ? inspirationSectionRef.current : undefined;
    if (!target) return;
    const frame = window.requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, [route]);

  const chooseMode = useCallback((mode: CreationMode) => {
    setCreationMode(mode);
    setModelTab(mode);
    if (mode === 'agent') setImageProviderId('evolink-gpt-image-2');
    if (mode === 'image') setImageProviderId('evolink-gpt-image-2');
    if (mode === 'video') setImageProviderId('deterministic-mock');
  }, []);

  const focusComposer = useCallback(() => {
    onNavigate('home');
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0 });
      promptRef.current?.focus();
    });
  }, [onNavigate]);

  const applyTemplate = useCallback((item: CommunityItem) => {
    setPrompt(item.prompt);
    setSelectedTemplate(item);
    setCreationMode('image');
    setImageProviderId('evolink-gpt-image-2');
    setModelTab('image');
    setSubmitError(undefined);
    onNavigate('home');
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0 });
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(item.prompt.length, item.prompt.length);
    });
  }, [onNavigate]);

  const clearAttachment = useCallback(async () => {
    if (submitting || isAttachmentBusy) return;
    const readyReference = attachment.status === 'ready' ? attachment.reference : undefined;
    setAttachment({ status: 'idle' });
    if (readyReference && onDiscardStagedAttachment) {
      try {
        await onDiscardStagedAttachment(readyReference);
      } catch {
        setSubmitError('附件已从输入区移除，但本地暂存清理未能确认。');
      }
    }
  }, [attachment, isAttachmentBusy, onDiscardStagedAttachment, submitting]);

  const stageSelectedFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setPlusMenuOpen(false);
    setSubmitError(undefined);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      if (attachment.status === 'ready') setSubmitError('新文件格式不支持，已保留原本机附件。仅支持 JPEG、PNG 或 WebP。');
      else setAttachment({ status: 'failed', message: '仅支持 JPEG、PNG 或 WebP 本地图片。' });
      return;
    }
    if (!onStageAttachment) {
      if (attachment.status === 'ready') setSubmitError('本地附件暂存接口不可用，已保留原本机附件。');
      else setAttachment({ status: 'failed', message: '本地附件暂存接口尚未接线；文件没有上传或离开浏览器。' });
      return;
    }
    const previous = attachment.status === 'ready'
      ? { displayName: attachment.displayName, reference: attachment.reference }
      : undefined;
    if (previous && !onDiscardStagedAttachment) {
      setSubmitError('原附件无法安全替换，已保留原附件。');
      return;
    }
    const staging: AttachmentState = { status: 'staging', displayName: file.name, ...(previous ? { previous } : {}) };
    attachmentRef.current = staging;
    setAttachment(staging);
    try {
      const reference = await onStageAttachment(file);
      if (!mountedRef.current) {
        if (onDiscardStagedAttachment) {
          await Promise.resolve(onDiscardStagedAttachment(reference)).catch(() => undefined);
        }
        return;
      }
      if (previous && onDiscardStagedAttachment) {
        try {
          await onDiscardStagedAttachment(previous.reference);
        } catch {
          await Promise.resolve(onDiscardStagedAttachment(reference)).catch(() => undefined);
          const restored: AttachmentState = { status: 'ready', ...previous };
          attachmentRef.current = restored;
          setAttachment(restored);
          setSubmitError('新附件已校验，但原附件清理未能确认；已保留原附件，不会丢失。');
          return;
        }
      }
      if (!mountedRef.current) {
        if (onDiscardStagedAttachment) {
          await Promise.resolve(onDiscardStagedAttachment(reference)).catch(() => undefined);
        }
        return;
      }
      const ready: AttachmentState = { status: 'ready', displayName: file.name, reference };
      attachmentRef.current = ready;
      setAttachment(ready);
    } catch (error) {
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : '本地图片校验或暂存失败。';
      if (previous) {
        const restored: AttachmentState = { status: 'ready', ...previous };
        attachmentRef.current = restored;
        setAttachment(restored);
        setSubmitError(`新附件未能安全暂存，已保留原附件。${message}`);
      } else {
        const failed: AttachmentState = { status: 'failed', message };
        attachmentRef.current = failed;
        setAttachment(failed);
      }
    }
  }, [attachment, onDiscardStagedAttachment, onStageAttachment]);

  const submitHandoff = useCallback(async () => {
    if (!hasPrompt || submitting || isAttachmentBusy || submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitError(undefined);
    setLocalSubmitting(true);
    const draft: ProductFrontstageHandoffDraft = {
      schemaVersion: 1,
      source: selectedTemplate ? 'inspiration-preset' : 'home-composer',
      action: 'prefill',
      prompt,
      creationMode,
      imageProviderId,
      videoProviderId: VIDEO_PROVIDER_ID,
      ...(selectedTemplate ? { preset: { id: selectedTemplate.id, category: selectedTemplate.category } } : {}),
      ...(attachment.status === 'ready' ? { stagedReference: attachment.reference } : {}),
      explicitSend: true,
    };
    try {
      handoffOwnsAttachmentRef.current = Boolean(draft.stagedReference && onSubmitHandoff);
      if (onSubmitHandoff) await onSubmitHandoff(draft);
      else onUseInspiration(prompt);
    } catch (error) {
      handoffOwnsAttachmentRef.current = false;
      setSubmitError(error instanceof Error && error.message.trim() ? error.message : '无法把本次输入带入工作台，请重试。');
    } finally {
      submitLockRef.current = false;
      setLocalSubmitting(false);
    }
  }, [
    attachment,
    creationMode,
    hasPrompt,
    imageProviderId,
    isAttachmentBusy,
    onSubmitHandoff,
    onUseInspiration,
    prompt,
    selectedTemplate,
    submitting,
  ]);

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitHandoff();
  };

  const attachmentError = attachment.status === 'failed' ? attachment.message : undefined;
  const visibleError = submitError ?? attachmentError;
  const isLanding = route === 'home' || route === 'community';

  return (
    <div className={`elyra-entry${isLanding ? ' skills-frontstage theme-light' : ` theme-${theme}`}`} data-testid="elyra-frontstage">
      <style>{ENTRY_STYLES}</style>
      {isLanding ? <header className="elyra-home-header"><button type="button" className="elyra-home-brand" onClick={focusComposer}><img src="/assets/elyra-mark.svg" alt="" /><b>ELYRA</b><span>跃序</span></button><nav aria-label="首页导航"><button type="button" aria-current={route === 'community' ? 'page' : undefined} onClick={() => { onNavigate('community'); window.requestAnimationFrame(() => document.getElementById('skills')?.scrollIntoView({ behavior: 'smooth' })); }}>探索 Skills</button><button type="button" onClick={() => onNavigate('projects')}>我的项目</button><button type="button" onClick={() => onOpenAssetLibrary?.()}>素材库</button></nav><button type="button" className="elyra-enter-canvas" onClick={onOpenWorkspace}>进入画布<ArrowRightIcon /></button></header> : <EntryRail
        route={route}
        theme={theme}
        onNavigate={onNavigate}
        onOpenAssets={() => onOpenAssetLibrary?.()}
        onToggleTheme={onToggleTheme}
        onLogo={focusComposer}
        onCreate={() => setProjectDialog({ mode: 'create' })}
      />}
      <main
        className={`entry-main${route === 'assets' ? ' entry-main-assets' : ''}`}
        data-testid={route === 'assets' ? 'frontstage-asset-page' : 'frontstage-home'}
      >
        {route === 'assets' ? (
          <AssetLibrarySection
            project={activeProject}
            assets={assets}
            onOpenProject={openProject}
            onAddAssetToCanvas={onAddAssetToCanvas}
          />
        ) : (
          <>
        {isLanding && <section className="entry-intro" aria-label="创作入口">
          <div className="entry-composer-wrap" ref={composerRegionRef}>
            <div className="entry-composer" data-testid="frontstage-composer">
              <textarea
                ref={promptRef}
                value={prompt}
                rows={2}
                maxLength={4_000}
                placeholder="描述你想创作的画面，或上传一张参考图…"
                aria-label="创作需求"
                data-testid="frontstage-composer-input"
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setSelectedTemplate(undefined);
                  setSubmitError(undefined);
                }}
                onKeyDown={onComposerKeyDown}
              />
              <div className="entry-composer-footer">
                <button
                  className="entry-square-button"
                  type="button"
                  aria-label="添加本地附件"
                  aria-expanded={plusMenuOpen}
                  disabled={submitting || isAttachmentBusy}
                  onClick={() => {
                    setPlusMenuOpen((value) => !value);
                    setModelMenuOpen(false);
                  }}
                  data-testid="frontstage-plus-button"
                >
                  <PaperClipIcon /><span>添加参考</span>
                </button>
                <input
                  ref={attachmentInputRef}
                  className="visually-hidden"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={submitting || isAttachmentBusy}
                  aria-label="选择本地参考图"
                  data-testid="frontstage-attachment-input"
                  onChange={(event) => void stageSelectedFile(event)}
                />
                {attachment.status === 'ready' ? (
                  <span className="entry-attachment-chip" data-testid="frontstage-attachment-ready">
                    <PhotoIcon />
                    <span>{attachment.displayName}</span>
                    <button type="button" disabled={submitting} onClick={() => void clearAttachment()} aria-label="移除本地附件"><XMarkIcon /></button>
                  </span>
                ) : null}
                {attachment.status === 'staging' ? <span className="entry-staging-label" aria-live="polite">本地校验与暂存中…</span> : null}
                <span className="entry-composer-spacer" />
                <button
                  className="entry-model-trigger"
                  type="button"
                  aria-label="选择入口模式与模型"
                  aria-expanded={modelMenuOpen}
                  onClick={() => {
                    setModelMenuOpen((value) => !value);
                    setPlusMenuOpen(false);
                    setModelTab(creationMode);
                  }}
                  data-testid="frontstage-model-button"
                >
                  <CubeTransparentIcon />
                  <span>{modelLabel(creationMode, imageProviderId)}</span>
                  <ChevronDownIcon />
                </button>
                <button
                  className="entry-send-button"
                  type="button"
                  disabled={!hasPrompt || submitting || isAttachmentBusy}
                  aria-label={submitting ? '正在进入工作台' : '把输入带入工作台'}
                  onClick={() => void submitHandoff()}
                  data-testid="frontstage-send"
                >
                  <span>{submitting ? '正在准备' : '开始创作'}</span>{submitting ? <BoltIcon /> : <ArrowRightIcon />}
                </button>
              </div>
              {visibleError ? <p className="entry-error" role="alert">{visibleError}</p> : null}
            </div>
            {plusMenuOpen ? (
              <div className="entry-menu entry-plus-menu" data-testid="frontstage-plus-menu">
                <button type="button" onClick={() => attachmentInputRef.current?.click()} disabled={isAttachmentBusy}>
                  <PaperClipIcon />
                  <span>上传本地图片</span>
                  <small>本机</small>
                </button>
                <button type="button" disabled data-capability="web-search">
                  <GlobeAltIcon />
                  <span>联网搜索</span>
                  <small>未开放</small>
                </button>
              </div>
            ) : null}
            {modelMenuOpen ? (
              <ModelMenu
                activeTab={modelTab}
                creationMode={creationMode}
                imageProviderId={imageProviderId}
                onTabChange={setModelTab}
                onSelectAgent={() => {
                  chooseMode('agent');
                  setModelMenuOpen(false);
                }}
                onSelectImage={() => {
                  chooseMode('image');
                  setModelMenuOpen(false);
                }}
                onSelectLocalImage={() => {
                  setCreationMode('image');
                  setImageProviderId('deterministic-mock');
                  setModelTab('image');
                  setModelMenuOpen(false);
                }}
                onSelectVideo={() => {
                  chooseMode('video');
                  setModelMenuOpen(false);
                }}
              />
            ) : null}
          </div>
          <div className="entry-mode-row" role="group" aria-label="入口模式">
            {(['agent', 'image', 'video'] as const).map((mode) => (
              <button
                key={mode}
                className={`entry-mode-button${creationMode === mode ? ' is-selected' : ''}`}
                type="button"
                aria-pressed={creationMode === mode}
                onClick={() => chooseMode(mode)}
                data-testid={`frontstage-mode-${mode}`}
              >
                <ModeIcon mode={mode} />
                {modeLabel(mode)}
              </button>
            ))}
          </div>
          <div className="entry-quick-row" aria-label="快捷模板" hidden>
            {COMMUNITY_ITEMS.map((item) => (
              <button className="entry-quick-chip" key={item.id} type="button" onClick={() => applyTemplate(item)}>
                <PaintBrushIcon />
                {item.title}
              </button>
            ))}
          </div>
        </section>}

        {route === 'projects' && <RecentProjects
          projects={projects}
          activeProjectId={activeProjectId}
          trashedProjects={trashedProjects}
          onOpenProject={openProject}
          onCreateRequest={() => setProjectDialog({ mode: 'create' })}
          onRenameRequest={(selectedProject) => setProjectDialog({ mode: 'rename', project: selectedProject })}
          onTrashRequest={(selectedProject) => setProjectDialog({ mode: 'trash', project: selectedProject })}
          onRestoreProject={onRestoreProject}
          sectionRef={projectSectionRef}
        />}
        {isLanding && <SkillGallery projectTitle={activeProject.title} onLaunch={props.onLaunchSkill ?? (async () => { throw new Error('Skill 执行入口尚未连接。'); })} onStage={onStageAttachment} onDiscard={onDiscardStagedAttachment} />}
          </>
        )}
      </main>
      {projectDialog?.mode === 'create' ? (
        <ProjectNameDialog
          mode="create"
          initialTitle={nextUntitledProjectName(projects)}
          onCancel={() => setProjectDialog(undefined)}
          onConfirm={(title) => onCreateProject ? onCreateProject(title) : false}
        />
      ) : null}
      {projectDialog?.mode === 'rename' ? (
        <ProjectNameDialog
          key={projectDialog.project.id}
          mode="rename"
          initialTitle={projectDialog.project.title}
          onCancel={() => setProjectDialog(undefined)}
          onConfirm={(title) => onRenameProject ? onRenameProject(projectDialog.project.id, title) : false}
        />
      ) : null}
      {projectDialog?.mode === 'trash' ? (
        <MoveToTrashDialog
          key={projectDialog.project.id}
          project={projectDialog.project}
          onCancel={() => setProjectDialog(undefined)}
          onConfirm={() => onMoveProjectToTrash ? onMoveProjectToTrash(projectDialog.project.id) : false}
        />
      ) : null}
    </div>
  );
}
