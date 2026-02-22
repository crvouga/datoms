import {useEffect} from 'react';
import type {RefObject} from 'react';
import type {TypeDefinition} from '../types';

/**
 * Hook to configure Monaco Editor with TypeScript types and compiler options
 * Note: Type safety is intentionally relaxed here due to Monaco editor's lack of proper TypeScript types
 * @param monacoRef - Ref to Monaco instance
 * @param typeDefinitions - Type definitions to add to Monaco's IntelliSense
 */
export function useMonacoConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco editor types are not available
  monacoRef: RefObject<any>,
  typeDefinitions: TypeDefinition[],
): void {
  useEffect(() => {
    if (monacoRef.current) {
      const monaco = monacoRef.current;

      // Set compiler options
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2020,
        allowNonTsExtensions: true,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        noEmit: true,
        esModuleInterop: true,
        jsx: monaco.languages.typescript.JsxEmit.React,
        reactNamespace: 'React',
        allowJs: true,
        typeRoots: ['node_modules/@types'],
      });

      // Add extra libs for better IntelliSense
      monaco.languages.typescript.typescriptDefaults.setExtraLibs(
        typeDefinitions.map((def) => ({
          content: def.content,
          filePath: def.filePath,
        })),
      );

      // Note: Formatting options are handled via the format action in useCodeStorage
      // Aggressive whitespace cleanup is applied post-formatting
    }
  }, [monacoRef, typeDefinitions]);
}
