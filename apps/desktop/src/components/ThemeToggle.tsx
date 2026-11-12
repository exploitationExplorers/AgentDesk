import { useCallback, useEffect, useState } from "react";
import { applyTheme, isDarkTheme, useUi } from "../stores/ui";
import { PixelToggle } from "./leibox/pixel-toggle/PixelToggle";

/** LeiBox 像素日夜开关，checked 对应日间模式。 */
export function ThemeToggle() {
  const theme = useUi((state) => state.theme);
  const [systemDark, setSystemDark] = useState(() => isDarkTheme("system"));

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const changeTheme = useCallback((checked: boolean) => {
    const next = checked ? "light" : "dark";
    useUi.getState().setTheme(next);
    applyTheme(next);
  }, []);

  return (
    <PixelToggle
      className="w-[88px] shrink-0 lg:w-[100px]"
      options={{
        checked: theme === "system" ? !systemDark : theme === "light",
        compact: true,
        label: "浅色主题",
        sound: false,
        onCheckedChange: changeTheme,
      }}
    />
  );
}
