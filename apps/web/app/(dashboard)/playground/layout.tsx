export default function PlaygroundLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex flex-1 flex-col overflow-hidden">{children}</div>;
}
