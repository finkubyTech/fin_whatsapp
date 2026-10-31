import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
    { ignores: ["build/**", "dist/**", "node_modules/**", "coverage/**", "views/**"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    prettier,
    {
        languageOptions: {
            globals: { process: "readonly", console: "readonly", __dirname: "readonly" },
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
            ],
        },
    },
    {
        // Plain Node (CommonJS) helper scripts
        files: ["scripts/**/*.js"],
        languageOptions: {
            sourceType: "commonjs",
            globals: { require: "readonly", module: "writable", process: "readonly", console: "readonly" },
        },
        rules: { "@typescript-eslint/no-require-imports": "off" },
    },
    {
        // jest.isolateModules needs require() to reload modules with a fresh env
        files: ["tests/**/*.ts"],
        rules: { "@typescript-eslint/no-require-imports": "off" },
    }
);
