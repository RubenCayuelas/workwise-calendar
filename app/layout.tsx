import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Workwise Calendar',
  description: 'Interactive calendar app for tracking and distributing work hours',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
