import "tailwindcss/preflight.css";
import { createRoot } from "react-dom/client";
import { WelcomePage } from "./features/welcome/WelcomePage";

createRoot(document.getElementById("root")!).render(<WelcomePage />);
