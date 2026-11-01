import { Text } from "ink";

/** 对齐 Claude Code 的 FallbackPermissionRequest：标题已由 PermissionDialog 展示，这里只需要正文。 */
export default function GenericApproval({ detail }: { detail: string }) {
  if (!detail) return null;
  return <Text dimColor>{detail}</Text>;
}
