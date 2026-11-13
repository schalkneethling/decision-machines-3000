Feature: Pressing Enter in a request field never sends the request

  Background:
    Given each panel is a form whose submit handler runs the request
    And the tree editor's single-line fields are the question Id, each option's name, and the other one-line text inputs
    And HTML's implicit submission would send a form when Enter is pressed in a text input, which spends provider credit
    # The fix cancels the keydown for Enter in a single-line field. It does not add a Ctrl + Enter or Cmd + Enter
    # shortcut for Run. A shortcut would need aria-keyshortcuts and visible text, so it is left to the redesign.

  Scenario: Enter in a question's Id field posts nothing
    Given a panel holding a valid request
    When the person presses Enter in a question's Id field
    Then nothing is posted
    And the answer area does not change

  Scenario: Enter in an option's name field posts nothing
    Given the "Pick one option" panel with options
    When the person presses Enter in an option's name field
    Then nothing is posted

  Scenario: Enter in a textarea still inserts a new line
    Given a panel holding a valid request
    When the person presses Enter in a textarea, such as the "What the model reads" field
    Then the key's default action is not cancelled
    And the request is not posted

  Scenario: Run still works from the keyboard
    Given a panel holding a valid request
    When the person focuses Run and activates it with Enter or Space
    Then the request is posted as before

  Scenario: Run still works with the mouse
    Given a panel holding a valid request
    When the person clicks Run
    Then the request is posted as before

  Scenario: Enter that confirms an input-method composition is left alone
    Given a single-line field with an input-method composition in progress
    When the person presses Enter to confirm the composition
    Then the key's default action is not cancelled, so the composition still commits
