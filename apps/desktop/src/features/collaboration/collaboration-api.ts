import type {
  CollaborationDecisionInput,
  CollaborationMember,
  CollaborationMemberInput,
  CollaborationMessageInput,
  CollaborationRoom,
  CollaborationRoomDetail,
  CollaborationRoomInput,
  CollaborationSources,
} from "@agentdesk/shared";
import { http, request } from "../../lib/http";

const roomPath = (id: string) => `/collaboration/rooms/${encodeURIComponent(id)}`;

export const collaborationApi = {
  sources: () => http.get<CollaborationSources>("/collaboration/sources"),
  members: () => http.get<CollaborationMember[]>("/collaboration/members"),
  addMember: (input: CollaborationMemberInput) =>
    http.post<CollaborationMember>("/collaboration/members", input),
  rooms: () => http.get<CollaborationRoom[]>("/collaboration/rooms"),
  createRoom: (input: CollaborationRoomInput) =>
    http.post<CollaborationRoom>("/collaboration/rooms", input),
  detail: (id: string, signal?: AbortSignal) =>
    request<CollaborationRoomDetail>("GET", roomPath(id), undefined, undefined, { signal }),
  discuss: (id: string, input: CollaborationMessageInput) =>
    http.post<CollaborationRoomDetail>(`${roomPath(id)}/discuss`, input),
  message: (id: string, input: CollaborationMessageInput) =>
    http.post<CollaborationRoomDetail>(`${roomPath(id)}/messages`, input),
  stop: (id: string) => http.post<CollaborationRoomDetail>(`${roomPath(id)}/stop`),
  decide: (id: string, input: CollaborationDecisionInput) =>
    http.post<CollaborationRoomDetail>(`${roomPath(id)}/decision`, input),
};
