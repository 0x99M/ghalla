import type { ReactNode } from 'react';

export const metadata = {
  title: 'Ghalla Ops',
  description: 'Internal operator portal',
};

/**
 * Unstyled on purpose. Design arrives as a later brief; anything invented here
 * would only have to be deleted, and would read as a decision in the meantime.
 */
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
