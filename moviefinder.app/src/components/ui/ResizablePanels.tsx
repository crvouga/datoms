import { useMemo, type ReactNode } from "react";
import { PanelGroup, type PanelGroupProps } from "react-resizable-panels";

export interface ResizablePanelsRenderProps {
  /**
   * Panel sizes to use for Panel defaultSize props
   * These are loaded from localStorage or fallback to defaultSizes
   */
  panelSizes: number[];
}

export interface ResizablePanelsProps extends Omit<
  PanelGroupProps,
  "onLayout" | "children"
> {
  /**
   * Unique key for localStorage persistence
   */
  storageKey: string;
  /**
   * Default panel sizes as percentages (must sum to ~100)
   * Used to validate loaded sizes and as fallback
   */
  defaultSizes: number[];
  /**
   * Render prop function that receives panel sizes
   */
  children: (props: ResizablePanelsRenderProps) => ReactNode;
}

/**
 * Reusable ResizablePanels component that handles state management
 * and localStorage persistence for panel sizes using render props.
 *
 * @example
 * ```tsx
 * <ResizablePanels
 *   storageKey="my-panels"
 *   defaultSizes={[75, 25]}
 *   direction="horizontal"
 * >
 *   {({ panelSizes }) => (
 *     <>
 *       <Panel defaultSize={panelSizes[0]} minSize={30}>
 *         <div>Left Panel</div>
 *       </Panel>
 *       <PanelResizeHandle />
 *       <Panel defaultSize={panelSizes[1]} minSize={20}>
 *         <div>Right Panel</div>
 *       </Panel>
 *     </>
 *   )}
 * </ResizablePanels>
 * ```
 */
export function ResizablePanels({
  storageKey,
  defaultSizes,
  children,
  ...panelGroupProps
}: ResizablePanelsProps) {
  // Validate defaultSizes
  if (defaultSizes.length < 2) {
    throw new Error("ResizablePanels requires at least 2 default sizes");
  }

  // Load saved panel sizes from localStorage
  const panelSizes = useMemo((): number[] => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const sizes = JSON.parse(saved) as number[];
        if (
          Array.isArray(sizes) &&
          sizes.length === defaultSizes.length &&
          sizes.every((s) => typeof s === "number" && s > 0 && s < 100)
        ) {
          return sizes;
        }
      }
    } catch {
      // Ignore errors, use defaults
    }
    return defaultSizes;
  }, [storageKey, defaultSizes]);

  // Save panel sizes to localStorage when they change
  const handlePanelLayout = (sizes: number[]) => {
    if (sizes.length === defaultSizes.length) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(sizes));
      } catch {
        // Ignore localStorage errors
      }
    }
  };

  return (
    <PanelGroup {...panelGroupProps} onLayout={handlePanelLayout}>
      {children({ panelSizes })}
    </PanelGroup>
  );
}
