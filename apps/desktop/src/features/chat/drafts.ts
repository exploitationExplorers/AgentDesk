import { create } from "zustand";

export interface ChatDraft {
  text: string;
  revision: number;
}

export const EMPTY_CHAT_DRAFT: ChatDraft = { text: "", revision: 0 };

export function conversationDraftScope(conversationId?: string): string {
  return conversationId ? `conversation:${conversationId}` : "conversation:new";
}

interface ChatDraftState {
  drafts: Record<string, ChatDraft>;
  setText: (scopeId: string, text: string) => void;
  apply: (scopeId: string, revision: number, text: string) => boolean;
  move: (sourceScope: string, targetScope: string) => void;
}

// 草稿只保存在当前应用内存，避免把未发送内容额外写入浏览器存储。
export const useChatDrafts = create<ChatDraftState>((set, get) => ({
  drafts: {},
  setText: (scopeId, text) =>
    set((state) => {
      const current = state.drafts[scopeId] ?? EMPTY_CHAT_DRAFT;
      if (current.text === text) return state;
      return {
        drafts: { ...state.drafts, [scopeId]: { text, revision: current.revision + 1 } },
      };
    }),
  apply: (scopeId, revision, text) => {
    const current = get().drafts[scopeId] ?? EMPTY_CHAT_DRAFT;
    if (current.revision !== revision) return false;
    set((state) => ({
      drafts: { ...state.drafts, [scopeId]: { text, revision: revision + 1 } },
    }));
    return true;
  },
  move: (sourceScope, targetScope) => {
    if (sourceScope === targetScope) return;
    set((state) => {
      const source = state.drafts[sourceScope] ?? EMPTY_CHAT_DRAFT;
      if (!source.text) return state;
      const target = state.drafts[targetScope] ?? EMPTY_CHAT_DRAFT;
      // 新会话取得 ID 后，把等待期间续写的内容一起交给该会话。
      if (target.text) return state;
      return {
        drafts: {
          ...state.drafts,
          [sourceScope]: { text: "", revision: source.revision + 1 },
          [targetScope]: { text: source.text, revision: target.revision + 1 },
        },
      };
    });
  },
}));
