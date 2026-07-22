const globals = require("globals");
const prettier = require("eslint-config-prettier");
const typescript = require("@typescript-eslint/eslint-plugin");

module.exports = [
    { ignores: ["build/**", "dist/**"] },
    ...typescript.configs["flat/recommended"],
    {
        files: ["src/**/*.{js,ts}"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.browser,
                ...globals.es2021,
            },
        },
        rules: {
            ...prettier.rules,
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-empty-function": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    vars: "all",
                    args: "none",
                    ignoreRestSiblings: true,
                    varsIgnorePattern: "([Ii]gnored)|([Uu]nused)|(_)",
                },
            ],
            "@typescript-eslint/no-inferrable-types": [
                "warn",
                { ignoreProperties: true, ignoreParameters: true },
            ],
            "@typescript-eslint/no-empty-object-type": "off",
            "@typescript-eslint/no-unused-expressions": "off",
            "prefer-const": "off",
        },
    },
];
