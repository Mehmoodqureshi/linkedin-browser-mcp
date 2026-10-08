/**
 * Barrel export for the LinkedIn action modules.
 *
 * Each class takes a Playwright `Page` (and, for auth, persisted-state paths)
 * in its constructor. Re-exported alongside every public type interface so the
 * driver and the MCP tool layer can import from a single entry point.
 */

export { AuthActions } from './auth';
export type { LoginResult, AuthStatus, AuthPaths } from './auth';

export { ProfileActions } from './profile';
export type {
  ProfileData,
  ExperienceEntry,
  EducationEntry,
  ContactInfo,
  RecommendationEntry,
} from './profile';

export { ProfileEditActions, MAX_HEADLINE_LENGTH, MAX_ABOUT_LENGTH } from './profile-edit';
export type {
  ProfileUpdateInput,
  ProfileUpdateResult,
  ProfileFieldUpdate,
  ProfileEditField,
} from './profile-edit';

export { SearchActions } from './search';
export type {
  SearchResult,
  JobResult,
  CompanyResult,
  PeopleFilters,
  JobFilters,
  CompanyFilters,
  ConnectionDegree,
} from './search';

export { MessagingActions } from './messages';
export type { SendMessageResult, ConversationSummary, ChatMessage } from './messages';

export { ConnectionActions, MAX_NOTE_LENGTH } from './connections';
export type {
  Connection,
  ConnectionRequestResult,
  PendingRequest,
  SentInvitation,
} from './connections';

export { ApplyActions, normalizeJobUrl, answerKey } from './apply';
export type { ApplyResult, ApplyOptions, ApplicationQuestion, QuestionKind } from './apply';

export { FeedActions } from './feed';
export type {
  FeedPost,
  NotificationItem,
  MemberPost,
  ReactionType,
  ReactionResult,
  CommentResult,
} from './feed';

export {
  NeedsLoginError,
  ActionError,
  LINKEDIN_BASE,
  ACTION_DELAY_MS,
  rateLimitDelay,
} from './common';
