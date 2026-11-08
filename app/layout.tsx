import './globals.css';

export const metadata = { title: 'Peer Group 분석 에이전트', description: '근거 기반 비교기업 선정 — 미국 상장 반도체' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
