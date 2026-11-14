/**
 * Language knowledge used by Nexus.
 *
 * Each profile describes how one language family is written: its
 * comments, strings, block style, keywords and common built-in names.
 * Everything here is GENERAL language knowledge. It explains what
 * syntax means; it never describes what a particular repository does.
 *
 * To support another language, add a profile and map its VS Code
 * language id in LANGUAGE_IDS. Nothing else needs to change.
 */

export type LanguageFamily =
  | "python"
  | "javascript"
  | "java"
  | "c"
  | "csharp"
  | "go"
  | "rust"
  | "generic";

/**
 * detailed: imports, declarations, assignments, keywords and block flow.
 * basic:    imports, declarations, simple assignments and keywords.
 * generic:  names, strings, numbers and call/member syntax only.
 */
export type SupportLevel = "detailed" | "basic" | "generic";

export interface KeywordInfo {
  /** The technical term a learner can search for. */
  readonly term: string;
  /** One or two plain-language sentences. */
  readonly plain: string;
}

export interface LanguageProfile {
  readonly family: LanguageFamily;
  readonly label: string;
  readonly support: SupportLevel;
  readonly lineComments: readonly string[];
  readonly blockComment?: readonly [string, string];
  readonly tripleQuotedStrings: boolean;
  readonly backtickStrings: boolean;
  /** Letters allowed directly before a string quote, e.g. Python f"..." */
  readonly stringPrefixLetters: string;
  /** Whether a single quote always starts a string (false for Rust lifetimes). */
  readonly singleQuoteStrings: boolean;
  readonly blockStyle: "indent" | "braces";
  readonly memberOperators: readonly string[];
  readonly keywords: Readonly<Record<string, KeywordInfo>>;
  readonly builtins: Readonly<Record<string, string>>;
}

const SHARED_C_KEYWORDS: Record<string, KeywordInfo> = {
  if: {
    term: "if statement",
    plain: "Checks a condition. The block that follows runs only when the condition is true.",
  },
  else: {
    term: "else branch",
    plain: "The block that runs when the `if` condition before it was false.",
  },
  for: {
    term: "for loop",
    plain: "Repeats a block of code, usually once for each item or each count.",
  },
  while: {
    term: "while loop",
    plain: "Repeats a block for as long as its condition stays true.",
  },
  do: {
    term: "do-while loop",
    plain: "Runs a block once, then keeps repeating it while the condition is true.",
  },
  switch: {
    term: "switch statement",
    plain: "Compares one value against several cases and runs the matching one.",
  },
  case: {
    term: "case label",
    plain: "One of the possible matches inside a `switch`.",
  },
  break: {
    term: "break",
    plain: "Stops the nearest loop or `switch` immediately.",
  },
  continue: {
    term: "continue",
    plain: "Skips the rest of this loop round and starts the next one.",
  },
  return: {
    term: "return statement",
    plain: "Ends the function and hands a value back to whoever called it.",
  },
  try: {
    term: "try block",
    plain: "Runs code that might fail, so the failure can be handled instead of crashing.",
  },
  catch: {
    term: "catch block",
    plain: "The code that runs if something inside the `try` block failed.",
  },
  finally: {
    term: "finally block",
    plain: "Code that runs after `try`, whether or not something failed.",
  },
  throw: {
    term: "throw",
    plain: "Signals an error on purpose and stops normal execution here.",
  },
  new: {
    term: "new",
    plain: "Creates a new object from a class.",
  },
  class: {
    term: "class",
    plain: "A blueprint that groups data and the functions that work on it.",
  },
  this: {
    term: "this",
    plain: "Refers to the current object, the one whose code is running.",
  },
  true: { term: "boolean true", plain: "The value that means yes / on." },
  false: { term: "boolean false", plain: "The value that means no / off." },
  null: { term: "null", plain: "A value that means “nothing here”." },
};

const PYTHON: LanguageProfile = {
  family: "python",
  label: "Python",
  support: "detailed",
  lineComments: ["#"],
  tripleQuotedStrings: true,
  backtickStrings: false,
  stringPrefixLetters: "rRbBfFuU",
  singleQuoteStrings: true,
  blockStyle: "indent",
  memberOperators: ["."],
  keywords: {
    import: {
      term: "import statement",
      plain: "Loads code from another module so this file can use it.",
    },
    from: {
      term: "from-import",
      plain: "Picks specific names out of a module instead of importing the whole thing.",
    },
    as: {
      term: "alias (as)",
      plain: "Gives something a different, usually shorter, name to use in this file.",
    },
    def: {
      term: "function definition",
      plain: "Creates a function: a named set of steps that runs only when it is called.",
    },
    class: {
      term: "class definition",
      plain: "Creates a class: a blueprint that groups data and the functions that work on it.",
    },
    return: {
      term: "return statement",
      plain: "Ends the function and hands a value back to whoever called it.",
    },
    if: {
      term: "if statement",
      plain: "Checks a condition. The indented block below runs only when the condition is true.",
    },
    elif: {
      term: "elif branch",
      plain: "Short for “else if”. Checked only when the conditions above it were false.",
    },
    else: {
      term: "else branch",
      plain: "The block that runs when none of the conditions above it were true.",
    },
    for: {
      term: "for loop",
      plain: "Repeats the indented block once for each item in a collection.",
    },
    while: {
      term: "while loop",
      plain: "Repeats the indented block for as long as its condition stays true.",
    },
    in: {
      term: "in",
      plain: "In a loop it means “each item inside”. In a condition it asks “is this inside that?”.",
    },
    with: {
      term: "with statement (context manager)",
      plain: "Sets something up, runs the indented block using it, then cleans up automatically when the block ends.",
    },
    try: {
      term: "try block",
      plain: "Runs code that might fail, so the failure can be handled instead of crashing.",
    },
    except: {
      term: "except block",
      plain: "The code that runs if something inside the `try` block failed.",
    },
    finally: {
      term: "finally block",
      plain: "Code that runs after `try`, whether or not something failed.",
    },
    raise: {
      term: "raise",
      plain: "Signals an error on purpose and stops normal execution here.",
    },
    lambda: {
      term: "lambda (anonymous function)",
      plain: "A tiny function written in one line, without a name.",
    },
    yield: {
      term: "yield",
      plain: "Hands back one value and pauses the function so it can continue later.",
    },
    async: {
      term: "async",
      plain: "Marks a function that can pause while waiting, letting other work run meanwhile.",
    },
    await: {
      term: "await",
      plain: "Pauses here until a slow operation finishes, then continues with its result.",
    },
    pass: { term: "pass", plain: "A placeholder that does nothing." },
    break: { term: "break", plain: "Stops the nearest loop immediately." },
    continue: {
      term: "continue",
      plain: "Skips the rest of this loop round and starts the next one.",
    },
    not: { term: "not", plain: "Flips true to false and false to true." },
    and: { term: "and", plain: "True only when both sides are true." },
    or: { term: "or", plain: "True when at least one side is true." },
    is: { term: "is", plain: "Asks whether two names point at the very same object." },
    None: { term: "None", plain: "Python's value for “nothing here”." },
    True: { term: "True", plain: "The value that means yes / on." },
    False: { term: "False", plain: "The value that means no / off." },
    self: {
      term: "self",
      plain: "Inside a class, `self` is the particular object the method is working on.",
    },
    global: {
      term: "global",
      plain: "Says a name inside this function refers to the file-level variable.",
    },
    nonlocal: {
      term: "nonlocal",
      plain: "Says a name refers to a variable in the enclosing function.",
    },
    assert: {
      term: "assert",
      plain: "Checks that something is true and stops with an error if it is not.",
    },
    del: { term: "del", plain: "Removes a name or an item." },
  },
  builtins: {
    print: "Python's built-in function for showing text on the screen.",
    len: "Python's built-in function that counts the items in something.",
    range: "Python's built-in that produces a sequence of numbers, often used in loops.",
    open: "Python's built-in function for opening a file.",
    str: "Python's built-in text type; calling it converts a value to text.",
    int: "Python's built-in whole-number type; calling it converts a value to a whole number.",
    float: "Python's built-in decimal-number type.",
    bool: "Python's built-in true/false type.",
    list: "Python's built-in ordered collection type.",
    dict: "Python's built-in type that maps keys to values.",
    set: "Python's built-in collection of unique items.",
    tuple: "Python's built-in fixed-size ordered collection type.",
    input: "Python's built-in function that reads text typed by the user.",
    type: "Python's built-in that reports what kind of value something is.",
    isinstance: "Python's built-in that checks whether a value is of a given type.",
    enumerate: "Python's built-in that pairs each item with its position number.",
    zip: "Python's built-in that walks through several collections side by side.",
    sum: "Python's built-in that adds up the items in a collection.",
    min: "Python's built-in that finds the smallest item.",
    max: "Python's built-in that finds the largest item.",
    sorted: "Python's built-in that returns a sorted copy of a collection.",
    super: "Python's built-in for reaching the parent class.",
    Exception: "Python's built-in base type for errors.",
    __name__: "A name Python sets automatically; it equals \"__main__\" when the file is run directly.",
    __init__: "The special method Python runs when a new object is created from a class.",
  },
};

const JAVASCRIPT_KEYWORDS: Record<string, KeywordInfo> = {
  ...SHARED_C_KEYWORDS,
  import: {
    term: "import statement",
    plain: "Loads code from another file or package so this file can use it.",
  },
  export: {
    term: "export",
    plain: "Makes something in this file available for other files to import.",
  },
  from: { term: "from", plain: "Names the file or package an import comes from." },
  as: {
    term: "alias (as)",
    plain: "Gives an imported thing a different name to use in this file.",
  },
  const: {
    term: "const declaration",
    plain: "Creates a name whose binding cannot be reassigned later.",
  },
  let: {
    term: "let declaration",
    plain: "Creates a variable that can be given a new value later.",
  },
  var: {
    term: "var declaration",
    plain: "An older way to create a variable. `let` and `const` are usually preferred.",
  },
  function: {
    term: "function declaration",
    plain: "Creates a function: a named set of steps that runs only when it is called.",
  },
  async: {
    term: "async",
    plain: "Marks a function that can pause while waiting, letting other work run meanwhile.",
  },
  await: {
    term: "await",
    plain: "Pauses here until a slow operation finishes, then continues with its result.",
  },
  typeof: { term: "typeof", plain: "Reports what kind of value something is, as text." },
  instanceof: {
    term: "instanceof",
    plain: "Asks whether an object was created from a particular class.",
  },
  undefined: { term: "undefined", plain: "The value of something that has not been given a value." },
  extends: { term: "extends", plain: "Says this class builds on top of another class." },
  interface: {
    term: "interface (TypeScript)",
    plain: "Describes the shape of an object: which properties it must have and their types.",
  },
  type: {
    term: "type alias (TypeScript)",
    plain: "Gives a name to a type so it can be reused.",
  },
  enum: {
    term: "enum (TypeScript)",
    plain: "A fixed list of named choices.",
  },
  implements: {
    term: "implements",
    plain: "Promises that this class has everything an interface requires.",
  },
  of: { term: "of", plain: "In a `for` loop it means “each item of this collection”." },
  in: { term: "in", plain: "Asks whether a property name exists in an object, or loops over property names." },
  yield: {
    term: "yield",
    plain: "Hands back one value and pauses the function so it can continue later.",
  },
  super: { term: "super", plain: "Refers to the parent class." },
  static: { term: "static", plain: "Belongs to the class itself, not to each object made from it." },
  readonly: { term: "readonly (TypeScript)", plain: "Can be read but not changed after it is set." },
  default: { term: "default", plain: "The fallback case, or the main thing a file exports." },
  delete: { term: "delete", plain: "Removes a property from an object." },
  void: { term: "void", plain: "Means “no value”." },
};

const JAVASCRIPT: LanguageProfile = {
  family: "javascript",
  label: "JavaScript",
  support: "detailed",
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  tripleQuotedStrings: false,
  backtickStrings: true,
  stringPrefixLetters: "",
  singleQuoteStrings: true,
  blockStyle: "braces",
  memberOperators: [".", "?."],
  keywords: JAVASCRIPT_KEYWORDS,
  builtins: {
    console: "JavaScript's built-in object for writing messages to the developer console.",
    require: "Node.js's function for loading another module.",
    document: "The browser's object that represents the current web page.",
    window: "The browser's object that represents the current tab.",
    Math: "JavaScript's built-in collection of maths helpers.",
    JSON: "JavaScript's built-in helper for converting data to and from JSON text.",
    Promise: "JavaScript's built-in type for a result that will arrive later.",
    Array: "JavaScript's built-in ordered list type.",
    Object: "JavaScript's built-in base type for key/value data.",
    String: "JavaScript's built-in text type.",
    Number: "JavaScript's built-in number type.",
    Boolean: "JavaScript's built-in true/false type.",
    Map: "JavaScript's built-in type that maps keys to values.",
    Set: "JavaScript's built-in collection of unique items.",
    Error: "JavaScript's built-in type for errors.",
    Date: "JavaScript's built-in type for dates and times.",
    parseInt: "JavaScript's built-in function that turns text into a whole number.",
    setTimeout: "A built-in function that runs code after a delay.",
    fetch: "A built-in function that requests data over the network.",
    process: "Node.js's object describing the running program.",
    module: "Node.js's object describing the current file as a module.",
    exports: "Node.js's object holding what this file makes available to others.",
  },
};

const ACCESS_KEYWORDS: Record<string, KeywordInfo> = {
  public: { term: "public", plain: "Can be used from anywhere." },
  private: { term: "private", plain: "Can be used only inside this class." },
  protected: { term: "protected", plain: "Can be used inside this class and classes that extend it." },
  static: { term: "static", plain: "Belongs to the class itself, not to each object made from it." },
  void: { term: "void", plain: "Means the function hands nothing back." },
  final: { term: "final", plain: "Cannot be changed after it is set." },
  interface: { term: "interface", plain: "A list of functions a class promises to provide." },
  enum: { term: "enum", plain: "A fixed list of named choices." },
  extends: { term: "extends", plain: "Says this class builds on top of another class." },
  implements: { term: "implements", plain: "Promises that this class has everything an interface requires." },
};

const JAVA: LanguageProfile = {
  family: "java",
  label: "Java",
  support: "basic",
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  tripleQuotedStrings: true,
  backtickStrings: false,
  stringPrefixLetters: "",
  singleQuoteStrings: true,
  blockStyle: "braces",
  memberOperators: [".", "::"],
  keywords: {
    ...SHARED_C_KEYWORDS,
    ...ACCESS_KEYWORDS,
    import: { term: "import statement", plain: "Lets this file use a class from another package by its short name." },
    package: { term: "package", plain: "Names the group (folder) this file's classes belong to." },
    super: { term: "super", plain: "Refers to the parent class." },
    throws: { term: "throws", plain: "Declares which errors a method may signal." },
    abstract: { term: "abstract", plain: "Declared but left for subclasses to fill in." },
    record: { term: "record", plain: "A compact class that just holds data." },
    var: { term: "var", plain: "Lets Java work out the variable's type from its value." },
    int: { term: "int", plain: "A whole-number type." },
    boolean: { term: "boolean", plain: "A true/false type." },
    double: { term: "double", plain: "A decimal-number type." },
    instanceof: { term: "instanceof", plain: "Asks whether an object is of a particular class." },
  },
  builtins: {
    System: "Java's built-in class for standard input, output and system facilities.",
    String: "Java's built-in text type.",
    Math: "Java's built-in collection of maths helpers.",
    Object: "The class every Java class builds on.",
    List: "Java's standard ordered collection interface.",
    Map: "Java's standard key-to-value collection interface.",
    Integer: "Java's object wrapper for whole numbers.",
  },
};

const C_FAMILY: LanguageProfile = {
  family: "c",
  label: "C/C++",
  support: "basic",
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  tripleQuotedStrings: false,
  backtickStrings: false,
  stringPrefixLetters: "LuU",
  singleQuoteStrings: true,
  blockStyle: "braces",
  memberOperators: [".", "->", "::"],
  keywords: {
    ...SHARED_C_KEYWORDS,
    ...ACCESS_KEYWORDS,
    include: { term: "#include directive", plain: "Copies the declarations from another file in, so this file can use them." },
    define: { term: "#define macro", plain: "Tells the preprocessor to replace a name with some text before compiling." },
    struct: { term: "struct", plain: "Groups several values together under one name." },
    typedef: { term: "typedef", plain: "Gives an existing type a new name." },
    using: { term: "using", plain: "Brings names from a namespace into reach, or creates a type alias." },
    namespace: { term: "namespace", plain: "A named area that keeps names from clashing with each other." },
    template: { term: "template", plain: "Code written once that works for many types." },
    const: { term: "const", plain: "Cannot be changed after it is set." },
    auto: { term: "auto", plain: "Lets the compiler work out the type from the value." },
    int: { term: "int", plain: "A whole-number type." },
    char: { term: "char", plain: "A single-character type." },
    float: { term: "float", plain: "A decimal-number type." },
    double: { term: "double", plain: "A more precise decimal-number type." },
    bool: { term: "bool", plain: "A true/false type." },
    sizeof: { term: "sizeof", plain: "Reports how many bytes a type or value takes up." },
    nullptr: { term: "nullptr", plain: "A pointer that points at nothing." },
    virtual: { term: "virtual", plain: "A method that subclasses are allowed to replace." },
    delete: { term: "delete", plain: "Frees memory that was created with `new`." },
  },
  builtins: {
    printf: "C's standard function for printing formatted text.",
    scanf: "C's standard function for reading formatted input.",
    malloc: "C's standard function for requesting memory.",
    free: "C's standard function for giving memory back.",
    std: "The namespace that holds the C++ standard library.",
    cout: "C++'s standard output stream.",
    cin: "C++'s standard input stream.",
    main: "The function where a C or C++ program starts running.",
  },
};

const CSHARP: LanguageProfile = {
  family: "csharp",
  label: "C#",
  support: "basic",
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  tripleQuotedStrings: true,
  backtickStrings: false,
  stringPrefixLetters: "@$",
  singleQuoteStrings: true,
  blockStyle: "braces",
  memberOperators: [".", "?."],
  keywords: {
    ...SHARED_C_KEYWORDS,
    ...ACCESS_KEYWORDS,
    using: { term: "using directive", plain: "Lets this file use types from a namespace by their short names." },
    namespace: { term: "namespace", plain: "A named area that keeps names from clashing with each other." },
    var: { term: "var", plain: "Lets C# work out the variable's type from its value." },
    async: { term: "async", plain: "Marks a method that can pause while waiting." },
    await: { term: "await", plain: "Pauses here until a slow operation finishes." },
    struct: { term: "struct", plain: "A lightweight type that groups several values." },
    foreach: { term: "foreach loop", plain: "Repeats a block once for each item in a collection." },
    readonly: { term: "readonly", plain: "Can be set once and not changed afterwards." },
    override: { term: "override", plain: "Replaces a method inherited from the parent class." },
    string: { term: "string", plain: "C#'s text type." },
    int: { term: "int", plain: "A whole-number type." },
    bool: { term: "bool", plain: "A true/false type." },
  },
  builtins: {
    Console: ".NET's built-in class for reading from and writing to the terminal.",
    String: ".NET's built-in text type.",
    Math: ".NET's built-in collection of maths helpers.",
    List: ".NET's standard resizable list type.",
    Task: ".NET's type for work that finishes later.",
  },
};

const GO: LanguageProfile = {
  family: "go",
  label: "Go",
  support: "basic",
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  tripleQuotedStrings: false,
  backtickStrings: true,
  stringPrefixLetters: "",
  singleQuoteStrings: true,
  blockStyle: "braces",
  memberOperators: ["."],
  keywords: {
    package: { term: "package clause", plain: "Names the package this file belongs to." },
    import: { term: "import declaration", plain: "Loads another package so this file can use it." },
    func: { term: "function declaration", plain: "Creates a function: a named set of steps that runs only when it is called." },
    var: { term: "var declaration", plain: "Creates a variable." },
    const: { term: "const declaration", plain: "Creates a named value that cannot change." },
    type: { term: "type declaration", plain: "Creates a new named type." },
    struct: { term: "struct", plain: "Groups several named values together." },
    interface: { term: "interface", plain: "A list of methods a type must have." },
    return: SHARED_C_KEYWORDS.return,
    if: SHARED_C_KEYWORDS.if,
    else: SHARED_C_KEYWORDS.else,
    for: { term: "for loop", plain: "Go's only loop keyword. Repeats a block." },
    range: { term: "range", plain: "Walks through each item of a collection in a `for` loop." },
    switch: SHARED_C_KEYWORDS.switch,
    case: SHARED_C_KEYWORDS.case,
    break: SHARED_C_KEYWORDS.break,
    continue: SHARED_C_KEYWORDS.continue,
    go: { term: "go statement (goroutine)", plain: "Starts a function running in the background." },
    defer: { term: "defer", plain: "Schedules a call to run when the surrounding function finishes." },
    chan: { term: "channel", plain: "A pipe that background tasks use to send values to each other." },
    select: { term: "select", plain: "Waits on several channels and handles whichever is ready first." },
    map: { term: "map", plain: "A type that maps keys to values." },
    nil: { term: "nil", plain: "Go's value for “nothing here”." },
    true: SHARED_C_KEYWORDS.true,
    false: SHARED_C_KEYWORDS.false,
  },
  builtins: {
    len: "Go's built-in function that counts the items in something.",
    make: "Go's built-in function that creates slices, maps and channels.",
    append: "Go's built-in function that adds items to a slice.",
    panic: "Go's built-in function that stops the program with an error.",
    error: "Go's built-in type for errors.",
    string: "Go's text type.",
    int: "A whole-number type.",
    bool: "A true/false type.",
  },
};

const RUST: LanguageProfile = {
  family: "rust",
  label: "Rust",
  support: "basic",
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  tripleQuotedStrings: false,
  backtickStrings: false,
  stringPrefixLetters: "rb",
  singleQuoteStrings: false,
  blockStyle: "braces",
  memberOperators: [".", "::"],
  keywords: {
    use: { term: "use declaration", plain: "Brings a name from another module into reach so it can be used by its short name." },
    mod: { term: "module", plain: "Declares a module: a named group of code." },
    fn: { term: "function definition", plain: "Creates a function: a named set of steps that runs only when it is called." },
    let: { term: "let binding", plain: "Creates a variable. It cannot be changed unless marked `mut`." },
    mut: { term: "mut", plain: "Marks a variable as changeable." },
    struct: { term: "struct", plain: "Groups several named values together." },
    enum: { term: "enum", plain: "A type that is exactly one of several named variants." },
    impl: { term: "impl block", plain: "Attaches functions to a type." },
    trait: { term: "trait", plain: "A list of functions a type can promise to provide." },
    match: { term: "match expression", plain: "Compares a value against patterns and runs the first one that fits." },
    pub: { term: "pub", plain: "Makes something usable from outside its module." },
    return: SHARED_C_KEYWORDS.return,
    if: SHARED_C_KEYWORDS.if,
    else: SHARED_C_KEYWORDS.else,
    for: SHARED_C_KEYWORDS.for,
    while: SHARED_C_KEYWORDS.while,
    loop: { term: "loop", plain: "Repeats a block forever until something breaks out of it." },
    in: { term: "in", plain: "In a `for` loop it means “each item inside”." },
    as: { term: "as", plain: "Renames an import, or converts a value to another type." },
    self: { term: "self", plain: "The particular value a method is working on." },
    Self: { term: "Self", plain: "The type the surrounding `impl` block is for." },
    break: SHARED_C_KEYWORDS.break,
    continue: SHARED_C_KEYWORDS.continue,
    async: { term: "async", plain: "Marks a function that can pause while waiting." },
    await: { term: "await", plain: "Pauses here until a slow operation finishes." },
    const: { term: "const", plain: "A named value fixed at compile time." },
    true: SHARED_C_KEYWORDS.true,
    false: SHARED_C_KEYWORDS.false,
  },
  builtins: {
    println: "Rust's standard macro for printing a line of text.",
    vec: "Rust's standard macro for creating a growable list.",
    String: "Rust's growable text type.",
    Vec: "Rust's growable list type.",
    Option: "Rust's type for a value that may be missing.",
    Result: "Rust's type for an operation that may fail.",
    Some: "The `Option` variant that holds a value.",
    None: "The `Option` variant that means “no value”.",
    Ok: "The `Result` variant for success.",
    Err: "The `Result` variant for failure.",
  },
};

const GENERIC: LanguageProfile = {
  family: "generic",
  label: "this language",
  support: "generic",
  lineComments: ["//", "#"],
  blockComment: ["/*", "*/"],
  tripleQuotedStrings: false,
  backtickStrings: false,
  stringPrefixLetters: "",
  singleQuoteStrings: true,
  blockStyle: "braces",
  memberOperators: ["."],
  keywords: {},
  builtins: {},
};

const LANGUAGE_IDS: Readonly<Record<string, { profile: LanguageProfile; label?: string }>> = {
  python: { profile: PYTHON },
  javascript: { profile: JAVASCRIPT },
  javascriptreact: { profile: JAVASCRIPT, label: "JavaScript (JSX)" },
  typescript: { profile: JAVASCRIPT, label: "TypeScript" },
  typescriptreact: { profile: JAVASCRIPT, label: "TypeScript (TSX)" },
  java: { profile: JAVA },
  c: { profile: C_FAMILY, label: "C" },
  cpp: { profile: C_FAMILY, label: "C++" },
  csharp: { profile: CSHARP },
  go: { profile: GO },
  rust: { profile: RUST },
};

/**
 * Returns the profile for a VS Code language id. Unknown languages get
 * the generic profile, labelled with their own id, so Nexus can still
 * explain names, strings and call syntax while being clear about limits.
 */
export function profileFor(languageId: string): LanguageProfile {
  const entry = LANGUAGE_IDS[languageId];
  if (entry) {
    return entry.label ? { ...entry.profile, label: entry.label } : entry.profile;
  }

  return { ...GENERIC, label: languageId || "this language" };
}

export function describeSupport(profile: LanguageProfile): string {
  switch (profile.support) {
    case "detailed":
      return `Nexus reads ${profile.label} imports, functions, classes, assignments and block structure.`;
    case "basic":
      return `Nexus has basic ${profile.label} support: imports, declarations, simple assignments and keywords. Less common syntax may not be recognised.`;
    default:
      return `Nexus has no specific knowledge of ${profile.label}. It can still recognise names, text, numbers and call syntax, and it reports what the language server provides.`;
  }
}
