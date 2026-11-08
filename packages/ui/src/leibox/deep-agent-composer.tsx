import {
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "../cn";

/** LeiBox Deep Agent Composer 的 surface/editor/toolbar 结构；业务控件通过插槽接入。 */
export function DeepAgentComposer({
  value,
  onValueChange,
  onSubmit,
  toolbar,
  action,
  large,
  inputRef,
  className,
  ...input
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "onSubmit" | "value"> & {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  toolbar: ReactNode;
  action: ReactNode;
  large?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? localRef;
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [value, large, textarea]);
  return (
    <div
      data-leibox="deep-agent-composer"
      data-message-composer-surface
      className={cn("lb-composer lb-glass", large && "lb-composer-large", className)}
    >
      <div className="lb-composer-editor">
        <textarea
          {...input}
          ref={textarea}
          value={value}
          rows={large ? 3 : 2}
          className="lb-composer-textarea"
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            input.onKeyDown?.(event);
            if (
              !event.defaultPrevented &&
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
      <div className="lb-composer-toolbar">
        <div className="lb-composer-primary-tools">{toolbar}</div>
        <div className="lb-composer-actions">{action}</div>
      </div>
    </div>
  );
}
