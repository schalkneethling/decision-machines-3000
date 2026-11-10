Feature: Image features show as unavailable on a text-only provider, instead of being hidden

  Background:
    Given the page received the providers TypeSafe Jev (text only), SubQ Snap, and OpenAI Decisions from GET /api/providers
    And the names a sentence gives for providers that take images come from that list, in its order, and are never written in the client
    # TypeSafe Jev is first in the list and text only, so a first visit used to start with no sign that images exist.
    # The audit on 2026-10-25 found no image example and no image box in any of the three panels on TypeSafe Jev.
    And a live region (role="status") announces only what the user caused, and nothing on initial render

  Scenario: Each panel shows the image control as unavailable and names the providers that take images
    Given TypeSafe Jev is selected
    Then each panel shows its "Images" fieldset, with no hidden attribute and with data-unavailable
    And its sentence reads "TypeSafe Jev is text only. Choose SubQ Snap or OpenAI Decisions to attach images."
    And the file input is disabled
    And nothing is announced by the control

  Scenario: Pressing "Load image example" on TypeSafe Jev loads nothing and says why
    Given TypeSafe Jev is selected
    And "Load image example" is visible in each panel, with aria-disabled="true", and it takes focus
    When "Load image example" is pressed in the "Yes or no" panel
    Then nothing is loaded and no sample picture is fetched
    And the "Yes or no" panel's status line says "The image example needs a provider that takes images. TypeSafe Jev is text only. Choose SubQ Snap or OpenAI Decisions first."
    And the provider is still TypeSafe Jev
    # The page does not switch the provider. The choice changes all three panels, the stored preference, and which
    # company receives the person's data, so the person makes it, and the sentence tells them which providers to choose.

  Scenario: The capability line states the capability on the first load, and nothing is announced
    Given the page loads with TypeSafe Jev selected
    Then the capability line (#provider-capability) reads "TypeSafe Jev: Text only, no images."
    And the capability line is plain text, not a live region
    And the role="status" line (#provider-status) is empty
    When the user changes the provider
    Then the capability line follows, and the status line announces "Provider set to <name>." followed by the same capability sentence
    And the status line is visually hidden, so a sighted viewer reads the capability once

  Scenario: A drop or a paste on the unavailable control is refused in words
    Given TypeSafe Jev is selected
    When an image is dropped on a panel's fieldset, or pasted into the panel
    Then nothing is attached and the status says "<name> was not added: TypeSafe Jev is text only."

  Scenario: Images that were attached before the switch are kept and not sent
    Given two images are attached on SubQ Snap
    When the provider changes to TypeSafe Jev
    Then the fieldset stays, unavailable, and still lists the two images with their Remove buttons
    And the panel's notice says "TypeSafe Jev is text only. Your 2 images are kept and will not be sent."
    And Run sends application/json with no image parts

  Scenario: When no listed provider takes images, the sentences say so
    Given the page received only TypeSafe Jev
    Then the image control's sentence reads "TypeSafe Jev is text only, and no provider on this instance takes images."
    And pressing "Load image example" ends the status line with that same sentence

  Scenario: SubQ Snap behaves as before
    Given SubQ Snap is selected
    Then the image control is available, its file input is enabled, and its capability line states SubQ Snap's limits
    And "Load image example" has no aria-disabled and no data-unavailable, and loads the four sample pictures

  Scenario: With no provider selected the image features stay out of the page
    Given the provider list could not be loaded
    Then each panel's image fieldset and "Load image example" are hidden, because there is nothing true to say
