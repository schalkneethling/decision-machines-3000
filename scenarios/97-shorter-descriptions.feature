Feature: Shorten what screen readers hear in the image control and on each question

  Background:
    Given the image control is built by createAttachments in src/ui/attachments.ts
    And the tree editor is built by createComposer in src/ui/composer/tree.ts

  Scenario: The file input is described by one sentence that states the provider's limits
    Given a provider that takes images
    When the panel's image control is inspected
    Then the file input's aria-describedby names only the limits sentence
    And the instructions and the hint about asking about the images are still on the page, but they do not describe the input

  Scenario: The fieldset has no description, and the privacy note stays on the page
    Given a provider that takes images
    When the panel's image control is inspected
    Then the fieldset has no aria-describedby
    And the privacy note is still a visible paragraph inside the fieldset

  Scenario: The Id hint appears once in a panel
    Given a panel with four questions
    When the tree editor is inspected
    Then "Question ids are for your code only. The model never sees them." appears once, above the list of shared criteria and questions
    And none of the Id fields has an aria-describedby that points at it

  Scenario: The Id hint is left out of a panel with no questions
    Given a panel with no questions
    When the tree editor is inspected
    Then the Id hint is not on the page, because there are no Id fields for it to describe
