export default function SignInLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh w-full bg-slate-100 text-slate-900">
      {children}
    </div>
  );
}
