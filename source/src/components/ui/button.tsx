import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0 cursor-pointer select-none",
  {
    variants: {
      variant: {
        primary: "bg-accent text-white hover:bg-accent-hover",
        secondary:
          "bg-surface-3 text-ink hover:bg-surface-4 border border-edge",
        ghost: "text-ink-dim hover:bg-surface-3 hover:text-ink",
        outline: "border border-edge-strong text-ink hover:bg-surface-3",
        danger: "bg-bad/15 text-bad border border-bad/30 hover:bg-bad/25",
        subtle: "bg-accent-soft text-accent hover:bg-accent/20",
      },
      size: {
        sm: "h-8 px-3 text-[13px] [&_svg]:size-3.5",
        md: "h-9 px-4 text-sm [&_svg]:size-4",
        lg: "h-11 px-5 text-[15px] [&_svg]:size-4",
        icon: "h-9 w-9 [&_svg]:size-4",
        "icon-sm": "h-7 w-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-ffn-button="true"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
