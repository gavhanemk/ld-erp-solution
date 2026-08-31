/// <reference types="nativewind/types" />

// The stylesheet is imported for its side effect: it is what defines the theme
// variables the class names resolve against. TypeScript needs telling that a
// .css file is a legitimate thing to import.
declare module '*.css'
