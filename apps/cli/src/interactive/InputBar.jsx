import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export default function InputBar({ value, onChange, onSubmit, disabled }) {
  return (
    <Box>
      <Text color="cyan">{"› "}</Text>
      {disabled ? (
        <Text dimColor>等待当前这一轮结束…</Text>
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={!disabled}
          placeholder="输入消息，Enter 发送"
        />
      )}
    </Box>
  );
}
