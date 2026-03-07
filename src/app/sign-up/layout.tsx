export default function SignUpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh w-full bg-slate-50">
      {children}
    </div>
  );
}
