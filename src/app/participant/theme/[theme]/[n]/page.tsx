import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { QuestionPage } from "@/components/question/question-page";
import { THEME_IDS, type ThemeId } from "@/lib/home/themes";
import { QUESTIONS_PER_THEME } from "@/lib/question/constants";

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
  const { theme, n } = await params;
  const id = THEME_IDS.find((t) => t === theme) as ThemeId | undefined;
  const num = Number(n);
  if (!id || !/^[1-5]$/.test(n) || num < 1 || num > QUESTIONS_PER_THEME) notFound();
  return <QuestionPage theme={id} n={num} />;
}
