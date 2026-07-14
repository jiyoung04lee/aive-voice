import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "AIVE Voice",
  description: "선배 인터뷰 음성을 전사하는 서비스입니다.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
