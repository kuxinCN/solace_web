import MusicPlayer from "@/components/MusicPlayer";
import "./globals.css";

export const metadata = {
  title: "Solace",
  description: "给每一个不想说话的灵魂，一点慰藉。",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        <MusicPlayer />
      </body>
    </html>
  );
}
