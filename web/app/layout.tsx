import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Teams Chat × Bedrock KB',
  description: 'Microsoft Teams 대화 이력 기반 챗봇 (Amazon Bedrock Knowledge Base)',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
