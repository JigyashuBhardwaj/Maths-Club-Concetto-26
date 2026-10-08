import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { QuestionPage } from "@/components/question/question-page";
import { requireArea } from "@/lib/auth/guard";
import { THEME_IDS, type ThemeId } from "@/lib/home/themes";
import { QUESTIONS_PER_THEME } from "@/lib/contracts/competition";

type Params = { theme: string; n: string };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return THEME_IDS.flatMap((theme) =>
    Array.from({ length: QUESTIONS_PER_THEME }, (_, i) => ({ theme, n: String(i + 1) })),
  );
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { theme } = await params;
  return { title: `Theme ${theme.toUpperCase()}`, robots: { index: false, follow: false } };
}

export default async function Page({ params }: { params: Promise<Params> }) {
  await requireArea("participant");
  const { theme, n } = await params;
  const id = THEME_IDS.find((t) => t === theme) as ThemeId | undefined;
  const num = Number(n);
  if (!id || !/^[1-5]$/.test(n) || num < 1 || num > QUESTIONS_PER_THEME) notFound();
  // `key`: every question is its own component instance, so a draft or a loading state never carries over.
  return <QuestionPage key={`${id}-${num}`} theme={id} n={num} />;
}
