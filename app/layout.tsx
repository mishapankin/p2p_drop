import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Drop",
  description: "Send a file directly to another device.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <html lang="en"><body>{children}</body></html>;
}
