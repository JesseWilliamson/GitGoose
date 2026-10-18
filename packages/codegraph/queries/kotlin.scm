; Tags for @tree-sitter-grammars/tree-sitter-kotlin (its npm package ships no tags.scm).
; Adapted from fwcd/tree-sitter-kotlin's queries/tags.scm (MIT): that grammar's
; `simple_identifier` / `type_identifier` are plain `identifier` here, and navigation
; expressions have no suffix node.

(class_declaration
  name: (identifier) @name) @definition.class

(object_declaration
  name: (identifier) @name) @definition.class

(function_declaration
  name: (identifier) @name) @definition.function

(property_declaration
  (variable_declaration
    (identifier) @name)) @definition.constant

(enum_entry
  (identifier) @name) @definition.constant

(type_alias
  type: (identifier) @name) @definition.type

(call_expression
  (identifier) @name) @reference.call

(call_expression
  (navigation_expression
    (identifier) @name .)) @reference.call

(constructor_invocation
  (user_type
    (identifier) @name)) @reference.class
