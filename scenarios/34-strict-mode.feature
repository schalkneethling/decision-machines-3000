Feature: TypeScript strict mode is explicit and the type assertions are meaningful

  Scenario: The project type-checks with strict mode written in tsconfig.json
    Given tsconfig.json sets "strict" to true
    When tsc runs over src, server, vite.config.ts and env.d.ts
    Then it reports no errors

  Scenario: The contract type assertions can tell a type from the same type plus null
    Given src/decision/contract.type-check.ts temporarily asserts that string equals string | null
    When tsc runs
    Then it fails with TS2344 on that assertion
    And the assertion is removed before committing
