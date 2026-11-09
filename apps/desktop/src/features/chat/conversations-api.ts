import type {
  Conversation,
  ConversationGroup,
  ConversationPatch,
  ConversationQuery,
} from "@agentdesk/shared";
import { http } from "../../lib/http";

export type ClearConversationsResult = {
  deleted: string[];
  skipped: Array<{ id: string; title: string; reason: string }>;
};

export const conversationsApi = {
  list: (query: ConversationQuery = {}) => http.get<Conversation[]>("/conversations", query),
  get: (id: string) => http.get<Conversation>(`/conversations/${encodeURIComponent(id)}`),
  patch: (id: string, patch: ConversationPatch) =>
    http.patch<Conversation>(`/conversations/${encodeURIComponent(id)}`, patch),
  remove: (id: string) => http.delete<void>(`/conversations/${encodeURIComponent(id)}`),
  clear: (ids: string[]) => http.post<ClearConversationsResult>("/conversations/clear", { ids }),
  groups: () => http.get<ConversationGroup[]>("/conversation-groups"),
  createGroup: (name: string) => http.post<ConversationGroup>("/conversation-groups", { name }),
  renameGroup: (id: string, name: string) =>
    http.patch<ConversationGroup>(`/conversation-groups/${encodeURIComponent(id)}`, { name }),
  removeGroup: (id: string) => http.delete<void>(`/conversation-groups/${encodeURIComponent(id)}`),
};
