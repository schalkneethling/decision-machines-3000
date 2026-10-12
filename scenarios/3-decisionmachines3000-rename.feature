Feature: Product name is DecisionMachines3000

  Scenario: Browser tab and masthead show the new name
    Given the built page
    When the browser tab and masthead render
    Then both read "DecisionMachines3000"

  Scenario: No tracked file still uses the old name
    Given the repository's tracked files
    When they are searched case-insensitively for "jev 3000"
    Then nothing is found

  Scenario: Package names match the product
    Given package.json and package-lock.json
    When their name fields are read
    Then both are "decisionmachines3000"
    And running vp install leaves the lock file unchanged

  Scenario: A view preference saved under the old key is ignored
    Given a stored view preference under "jev-3000:view:score" set to "json"
    When the page loads
    Then the score panel opens in the tree view
