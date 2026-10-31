import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

export interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  focused?: boolean;
  placeholder?: string;
  color?: boolean;
}

export default function InputBar({
  value,
  onChange,
  onSubmit,
  disabled,
  focused = true,
  placeholder = "试试：修复这个项目的一个 Bug",
  color = true,
}: InputBarProps) {
  const [cursor, setCursor] = useState(() => [...value].length);
  const emittedValue = useRef(value);
  const characters = [...value];
  const position = Math.min(cursor, characters.length);
  // 补全和历史导航从外部替换输入时，把光标移动到末尾。
  useEffect(() => {
    if (emittedValue.current !== value) setCursor([...value].length);
    emittedValue.current = value;
  }, [value]);
  useInput((input, key) => {
    if (disabled || !focused) return;
    if (
      key.escape ||
      key.tab ||
      key.upArrow ||
      key.downArrow ||
      key.pageUp ||
      key.pageDown ||
      key.meta ||
      key.eventType === "release"
    )
      return;
    if (key.return && !key.shift) {
      onSubmit(value);
      return;
    }
    let next = [...characters];
    let offset = position;
    if (key.ctrl) {
      if (input === "a") offset = 0;
      else if (input === "e") offset = characters.length;
      else if (input === "u") {
        next = characters.slice(position);
        offset = 0;
      } else if (input === "k") next = characters.slice(0, position);
      else if (input === "w") {
        const before = characters
          .slice(0, position)
          .join("")
          .replace(/\s*\S+\s*$/, "");
        next = [...before, ...characters.slice(position)];
        offset = [...before].length;
      } else return;
    } else if (key.home) offset = 0;
    else if (key.end) offset = characters.length;
    else if (key.leftArrow) offset = Math.max(0, position - 1);
    else if (key.rightArrow) offset = Math.min(characters.length, position + 1);
    else if (key.backspace || key.delete) {
      if (position > 0) {
        next.splice(position - 1, 1);
        offset -= 1;
      }
    } else {
      const inserted = key.return
        ? ["\n"]
        : [...input.replace(/\r\n?/g, "\n").replace(/\t/g, "  ")].filter(
            (character) =>
              character === "\n" || (character >= " " && character.charCodeAt(0) !== 127),
          );
      next.splice(position, 0, ...inserted);
      offset += inserted.length;
    }
    setCursor(offset);
    const nextValue = next.join("");
    if (nextValue !== value) {
      emittedValue.current = nextValue;
      onChange(nextValue);
    }
  });
  return (
    <Box
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor={color ? "gray" : undefined}
      paddingX={1}
    >
      <Text color={color ? "cyan" : undefined}>{"› "}</Text>
      {disabled ? (
        <Text dimColor wrap="truncate-end">
          等待当前这一轮结束…
        </Text>
      ) : (
        <Text>
          {value ? (
            <>
              {characters.slice(0, position).join("")}
              <Text inverse={focused}>{characters[position] ?? " "}</Text>
              {characters.slice(position + 1).join("")}
            </>
          ) : (
            <Text dimColor>
              <Text inverse={focused}>{[...placeholder][0] ?? " "}</Text>
              {[...placeholder].slice(1).join("")}
            </Text>
          )}
        </Text>
      )}
    </Box>
  );
}
