import { notFound } from "next/navigation";

// Finkuby: NEXT_PUBLIC_SWAGGER_ENABLED was documented but never read, and this page is public. Hide it unless "true".
export default function SwaggerLayout({ children }: { children: React.ReactNode }) {
    if (process.env.NEXT_PUBLIC_SWAGGER_ENABLED !== "true") notFound();
    return children;
}
