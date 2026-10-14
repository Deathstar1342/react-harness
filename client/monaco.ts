import "monaco-editor/basic-languages/monaco.contribution";
import "monaco-editor/language/typescript/monaco.contribution";
import "monaco-editor/language/json/monaco.contribution";
import "monaco-editor/language/css/monaco.contribution";
import "monaco-editor/language/html/monaco.contribution";
import { loader } from "@monaco-editor/react";
import {createElement, useEffect, useRef} from 'react';
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(label)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(label))
      return new HtmlWorker();
    if (["typescript", "javascript"].includes(label)) return new TsWorker();
    return new EditorWorker();
  },
};
monaco.editor.defineTheme("harness", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1e1e1e",
    "editor.lineHighlightBackground": "#282828",
    "editorLineNumber.foreground": "#858585",
    "editor.selectionBackground": "#454545",
    "editorGutter.background": "#1e1e1e",
  },
});
loader.config({ monaco });
export { default as Editor } from "@monaco-editor/react";

// Own both comparison models so they are detached before disposal. The React
// adapter disposes attached models first, which Monaco rejects on preview close.
export function DiffEditor({original='',modified='',language='text',theme='harness',options={}}: {
  original?:string;modified?:string;language?:string;theme?:string;options?:monaco.editor.IStandaloneDiffEditorConstructionOptions;
}) {
  const container=useRef<HTMLDivElement>(null);
  const view=useRef<monaco.editor.IStandaloneDiffEditor|null>(null);
  useEffect(()=>{
    const editor=monaco.editor.createDiffEditor(container.current!,{automaticLayout:true});
    const before=monaco.editor.createModel(''),after=monaco.editor.createModel('');
    editor.setModel({original:before,modified:after});view.current=editor;
    return()=>{view.current=null;editor.setModel(null);editor.dispose();before.dispose();after.dispose();};
  },[]);
  useEffect(()=>{
    const models=view.current?.getModel();if(!models)return;
    if(models.original.getValue()!==original)models.original.setValue(original);
    if(models.modified.getValue()!==modified)models.modified.setValue(modified);
    monaco.editor.setModelLanguage(models.original,language);monaco.editor.setModelLanguage(models.modified,language);
  },[original,modified,language]);
  useEffect(()=>{view.current?.updateOptions({...options,readOnly:true,originalEditable:false});},[options]);
  useEffect(()=>{monaco.editor.setTheme(theme);},[theme]);
  return createElement('div',{ref:container,style:{width:'100%',height:'100%'}});
}
