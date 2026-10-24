import { notFound } from "next/navigation";

// Finkuby: the public API docs follow NEXT_PUBLIC_SWAGGER_ENABLED too; hidden unless "true".
export default function DocsLayout({ children }: { children: React.ReactNode }) {
    if (process.env.NEXT_PUBLIC_SWAGGER_ENABLED !== "true") notFound();
    return children;
}
