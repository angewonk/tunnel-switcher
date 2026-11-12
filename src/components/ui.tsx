import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const variants = {
  default: "bg-primary text-primary-foreground hover:bg-primary/80",
  outline:
    "border-border bg-background hover:bg-muted dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
  ghost: "hover:bg-muted",
  destructive:
    "bg-destructive/10 text-destructive hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30",
} as const;

const sizes = {
  default: "h-8 gap-1.5 px-2.5",
  sm: "h-7 gap-1 px-2 text-[0.8rem]",
  icon: "size-8",
} as const;

export function Button({
  variant = "default",
  size = "default",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-28 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}
