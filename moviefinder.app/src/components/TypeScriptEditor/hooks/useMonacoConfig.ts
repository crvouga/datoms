import { useEffect, RefObject } from "react";
import type { TypeDefinition } from "../types";

/**
 * Hook to configure Monaco Editor with TypeScript types and compiler options
 * @param monacoRef - Ref to Monaco instance
 * @param typeDefinitions - Type definitions to add to Monaco's IntelliSense
 */
export function useMonacoConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monacoRef: RefObject<any>,
  typeDefinitions: TypeDefinition[]
): void {
  useEffect(() => {
    if (monacoRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const monaco = monacoRef.current;

      // Set compiler options
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        target: monaco.languages.typescript.ScriptTarget.ES2020,
        allowNonTsExtensions: true,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        moduleResolution:
          monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        module: monaco.languages.typescript.ModuleKind.ESNext,
        noEmit: true,
        esModuleInterop: true,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        jsx: monaco.languages.typescript.JsxEmit.React,
        reactNamespace: "React",
        allowJs: true,
        typeRoots: ["node_modules/@types"],
      });

      // Add extra libs for better IntelliSense
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
      monaco.languages.typescript.typescriptDefaults.setExtraLibs(
        typeDefinitions.map((def) => ({
          content: def.content,
          filePath: def.filePath,
        }))
      );
    }
  }, [monacoRef.current, typeDefinitions]);
}
