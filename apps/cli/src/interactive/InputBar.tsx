import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  focused?: boolean;
}

export default function InputBar({
  value,
  onChange,
  onSubmit,
  disabled,
  focused = true,
}: InputBarProps) {
  return (
    <Box
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor="gray"
      paddingX={1}
    >
      <Text color="cyan">{"› "}</Text>
      {disabled ? (
        <Text dimColor>等待当前这一轮结束…</Text>
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={!disabled && focused}
          placeholder="试试：修复这个项目的一个 Bug"
        />
      )}
    </Box>
  );
}
