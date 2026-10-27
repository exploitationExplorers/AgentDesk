import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { createUi, loadPrompts } from "./ui.mjs";

function requireTerminal(input, output) {
  if (!input.isTTY || !output.isTTY)
    throw new Error(
      "此操作需要交互终端；自动化初始化请提供 --base-url、--model 和 --api-key-env。",
    );
}

function unwrap(prompts, value) {
  if (prompts.isCancel(value)) throw new Error("已取消配置。");
  return value;
}

export async function question(
  message,
  {
    secret = false,
    defaultValue = "",
    placeholder,
    validate,
    input = process.stdin,
    output = process.stderr,
    env = process.env,
  } = {},
) {
  requireTerminal(input, output);
  const ui = createUi({ stream: output, env });
  if (ui.interactive) {
    const prompts = await loadPrompts();
    const options = {
      message: message.trim(),
      input,
      output,
      withGuide: true,
      validate,
      placeholder: placeholder ?? defaultValue,
    };
    const value = secret
      ? await prompts.password({ ...options, mask: "▪" })
      : await prompts.text({ ...options, defaultValue });
    return unwrap(prompts, value).trim();
  }
  while (true) {
    const prompt = `${message.trim()}${defaultValue ? ` [${defaultValue}]` : ""}：`;
    const value = secret
      ? await secretQuestion(prompt, input, output)
      : (await plainQuestion(prompt, input, output)) || defaultValue;
    const error = validate?.(value);
    if (!error) return value;
    output.write(`${error}\n`);
  }
}

async function plainQuestion(prompt, input, output) {
  const reader = createInterface({ input, output });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  reader.once("SIGINT", cancel);
  try {
    return (await reader.question(prompt, { signal: controller.signal })).trim();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("已取消配置。");
    throw error;
  } finally {
    reader.removeListener("SIGINT", cancel);
    reader.close();
  }
}

async function secretQuestion(prompt, input, output) {
  output.write(prompt);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("keypress", onKey);
      input.off("end", cancel);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
    };
    const cancel = () => {
      cleanup();
      reject(new Error("已取消配置。"));
    };
    const onKey = (text, key = {}) => {
      if ((key.ctrl && ["c", "d"].includes(key.name)) || key.name === "escape") cancel();
      else if (["return", "enter"].includes(key.name)) {
        cleanup();
        resolve(value.trim());
      } else if (key.name === "backspace") value = [...value].slice(0, -1).join("");
      else if (typeof text === "string" && !key.ctrl && !key.meta) value += text;
    };
    input.on("keypress", onKey);
    input.once("end", cancel);
  });
}

export async function select(
  message,
  options,
  { input = process.stdin, output = process.stderr, env = process.env } = {},
) {
  requireTerminal(input, output);
  const ui = createUi({ stream: output, env });
  if (!ui.interactive) {
    output.write(`${message}\n`);
    options.forEach((option, index) => output.write(`  ${index + 1}. ${option.label}\n`));
    while (true) {
      const answer = await question("请选择", { defaultValue: "1", input, output, env });
      if (/^\d+$/.test(answer) && options[Number(answer) - 1])
        return options[Number(answer) - 1].value;
      output.write("请输入列表中的编号。\n");
    }
  }
  const prompts = await loadPrompts();
  return unwrap(
    prompts,
    await prompts.select({ message, options, input, output, withGuide: true }),
  );
}
