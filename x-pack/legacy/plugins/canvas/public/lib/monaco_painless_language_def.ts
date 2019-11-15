/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

// @ts-ignore
import { registries } from 'plugins/interpreter/registries';

import { CanvasFunction } from '../../types';

export const LANGUAGE_ID = 'painless';

/**
 * Extends the default type for a Monarch language so we can use
 * attribute references (like @keywords to reference the keywords list)
 * in the defined tokenizer
 */
interface Language extends monaco.languages.IMonarchLanguage {
  keywords: string[];
  symbols: RegExp;
  escapes: RegExp;
  digits: RegExp;
  boolean: ['true', 'false'];
  null: ['null'];
}

/**
 * Defines the Monarch tokenizer for syntax highlighting in Monaco of the
 * expression language. The tokenizer defines a set of regexes and actions/tokens
 * to mark the detected words/characters.
 * For more information, the Monarch documentation can be found here:
 * https://microsoft.github.io/monaco-editor/monarch.html
 */
export const language: Language = {
  // Set defaultToken to invalid to see what you do not tokenize yet
  defaultToken: 'invalid',

  // https://www.elastic.co/guide/en/elasticsearch/painless/master/painless-keywords.html
  keywords: [
    'if',
    'else',
    'while',
    'do',
    'for',
    'in',
    'continue',
    'break',
    'return',
    'new',
    'try',
    'catch',
    'throw',
    'this',
    'instanceof',
  ],

  // https://www.elastic.co/guide/en/elasticsearch/painless/master/painless-types.html
  typeKeywords: ['byte', 'short', 'char', 'int', 'long', 'float', 'double', 'boolean', 'def'],

  // https://www.elastic.co/guide/en/elasticsearch/painless/master/painless-operators.html
  operators: [
    '.',
    '?.',
    '++',
    '--',
    '+',
    '-',
    '!',
    '~',
    '*',
    '/',
    '%',
    '<<',
    '>>',
    '>>>',
    '>',
    '>=',
    '<',
    '<=',
    '==',
    '!=',
    '===',
    '!==',
    '&',
    '^',
    '|',
    '&&',
    '||',
    '?:',
    '=',
    '*=',
    '/=',
    '%=',
    '+=',
    '-=',
    '<<=',
    '>>=',
    '>>>=',
    '&=',
    '^=',
    '|=',
  ],

  // https://www.elastic.co/guide/en/elasticsearch/painless/master/painless-identifiers.html
  identifier: /[_a-zA-Z][_a-zA-Z-0-9]*/,
  whitespace: /[ \t\r\n]+/,

  symbols: /[=><!~?:&|+\-*\/\^%]+/,

  // The main tokenizer for our languages
  tokenizer: {
    root: [
      [
        /@identifier/,
        {
          cases: { '@typeKeywords': 'keyword', '@keywords': 'keyword', '@default': 'identifier' },
        },
      ],
      [/[ \t\r\n]+/, 'white'],
      [/[{}()\[\]]/, '@brackets'],
      [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
      [/\d+/, 'number'],
      [/[;,.]/, 'delimiter'],
    ],
  },
};

export function registerLanguage() {
  const functions = registries.browserFunctions.toArray();
  language.keywords = functions.map((fn: CanvasFunction) => fn.name);

  monaco.languages.register({ id: LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, language);
}
