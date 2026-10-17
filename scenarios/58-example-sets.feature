Feature: Two example sets, film reviews and images, with neither loaded by default

  Background:
    Given every panel opens empty: its request is {"primitive": <primitive>, "state": "", "questions": {}} in both the tree and the JSON view
    And each panel shows a short empty-state message that points at its load buttons
    And each panel has a group of load buttons labelled for that panel: "Load film example", and "Load image example" while the selected provider takes images
    # The buttons live in each panel, not in one shared control. A panel's edits, its images, and its status line
    # are all its own, so a shared control would have to ask about three panels' edits at once and announce into
    # three status lines. Per-panel buttons also sit beside the empty-state message that names them.
    And the example data is JSON files under src/decision/examples/, loaded with `import … with { type: "json" }`
    And each example is validated with validateDecisionRequest when the module loads, never cast to the request type
    And the status line (role="status") announces only what the user caused, and nothing on initial render

  # --- The empty start ------------------------------------------------------------------------------------------------

  Scenario: A fresh page holds neither example
    Given a fresh page load with a provider selected
    When the panels render
    Then no panel holds the film example or the image example
    And each panel's empty-state message is visible
    And each Run button is disabled
    And the empty-state message says Run is off until the panel holds a request
    And no status line has announced anything

  Scenario: The JSON view agrees with the empty tree
    Given a fresh page load
    When the JSON view of the Choice panel is opened
    Then the textarea holds {"primitive": "choice", "state": "", "questions": {}} formatted over several lines

  Scenario: Editing an empty panel hides the empty-state message and enables Run
    Given a fresh page load with a provider selected
    When the person types into the Noul panel's State field
    Then the empty-state message is hidden
    And Run is enabled, and pressing it reports the first problem in the status line as it always has

  # --- Loading the film example ----------------------------------------------------------------------------------------

  Scenario: Loading the film example into an empty Choice panel
    Given an empty Choice panel
    When "Load film example" is pressed
    Then the panel holds exactly choiceExample, the content of src/decision/examples/film/choice.json
    And the tree and the JSON view agree
    And the status line announces "Film example loaded."
    And Run is enabled
    And focus is on the State field of the tree

  Scenario: Loading the film example while the JSON view is open
    Given an empty Noul panel showing its JSON view
    When "Load film example" is pressed
    Then the textarea holds the film example as formatted JSON
    And focus is on the textarea

  # --- Loading the image example ---------------------------------------------------------------------------------------

  Scenario: Loading the image example into an empty Noul panel on SubQ
    Given an empty Noul panel with SubQ Snap selected
    When "Load image example" is pressed
    Then the panel holds the image example's state and questions for Noul
    And its four sample pictures are fetched and attached through the image control, in order, as picture-1.png, picture-2.png, picture-3.png, and picture-4.png
    And the panel's status line announces "Image example loaded."
    And that is the only announcement: the image control adds the pictures without announcing each one
    And focus is on the State field of the tree

  Scenario: The sample pictures' names do not give the answers away
    Given the model reads each image's file name in its label, such as "Image 1: picture-1.png" (#57)
    Then the sample pictures are named picture-1.png to picture-4.png, so an answer about them must come from the pixels

  Scenario: A sample picture the control refuses is named in the status line
    Given a provider whose limits leave no room for one of the sample pictures
    When "Load image example" is pressed
    Then the status line says how many of the four pictures were attached, followed by the control's reason for the one it refused
    And the image control's own status line stays empty, so the refusal is said once

  Scenario: A second press while an example is loading
    Given "Load image example" was pressed and the pictures are still being fetched
    When either load button in that panel is pressed again
    Then nothing new starts, and the status line says "An example is still loading into the Noul panel."
    And a picture that does not arrive within ten seconds ends the load with the could-not-be-loaded message

  Scenario: The image example is offered only on a provider that takes images
    Given TypeSafe Jev is selected, or no provider is
    Then every panel shows "Load film example" and hides "Load image example", because it could only refuse
    When SubQ Snap or OpenAI Decisions is selected
    Then "Load image example" is shown again

  Scenario: The provider changes to a text-only one while the sample pictures are fetched
    Given "Load image example" was pressed on SubQ Snap
    When TypeSafe Jev is selected before the pictures arrive
    Then the status line says the image example needs a provider that takes images and that TypeSafe Jev is text only
    And nothing is replaced

  Scenario: Loading an example over images the person attached asks first
    Given a Noul panel with one image the person attached, and SubQ Snap selected
    When "Load image example" is pressed
    Then the confirmation asks "Load the image example into the Noul panel?"
    And it says "This removes the image you attached. You cannot undo this."
    When the person agrees
    Then the person's image is removed and the four sample pictures take its place

  Scenario: The film example removes attached images too
    Given a Choice panel with the person's own state and one image they attached
    When "Load film example" is pressed and the person agrees
    Then the panel holds the film example and no images

  Scenario: An image still being added counts as the person's
    Given a Noul panel in which the person's image is still being read or shrunk
    When "Load film example" is pressed
    Then the load waits for the image to arrive, and then asks "This removes the image you attached. You cannot undo this."
    And an image added after the load has started to swap the pictures lands after the samples and is never taken for one of them

  Scenario: A sample picture that cannot be fetched
    Given an empty Score panel with OpenAI Decisions selected, and one sample picture's request fails
    When "Load image example" is pressed
    Then the status line says the sample pictures could not be loaded
    And the panel is unchanged: it is still empty, and no image is attached

  # --- Protecting edits ------------------------------------------------------------------------------------------------

  Scenario: The confirmation is a modal dialog that says there is no undo
    Given a Noul panel in which the person has typed into the State field
    When "Load film example" is pressed
    Then a dialog opens with showModal(), so the rest of the page is inert
    And its heading asks "Load the film example into the Noul panel?"
    And its message says "This replaces your request. You cannot undo this."
    And focus starts on "Keep my request", so pressing Enter keeps the request

  Scenario: Loading over edits asks first, and cancelling keeps them
    Given a Noul panel in which the person has typed into the State field
    When "Load film example" is pressed and the person presses "Keep my request" or Escape
    Then the panel is unchanged
    And the status line announces "Nothing loaded. Your request and images are kept."

  Scenario: Loading over edits asks first, and agreeing replaces them
    Given a Noul panel in which the person has typed into the State field
    When "Load film example" is pressed and the person agrees
    Then the panel holds the film example
    And the status line announces "Film example loaded."

  Scenario: Loading over an unedited example does not ask
    Given a Noul panel holding the film example, untouched since it was loaded
    When "Load image example" is pressed on an image provider
    Then no question is asked, and the image example replaces the film example

  Scenario: The image example's own pictures go without asking
    Given a Score panel holding the image example and its four sample pictures, untouched since it was loaded
    When "Load film example" is pressed
    Then no question is asked, and the sample pictures are removed with the rest of the example

  # --- The sample images -----------------------------------------------------------------------------------------------

  Scenario: Every sample image is within the catalog's caps
    Given the PNG files in src/decision/examples/images/
    When the tests run
    Then each file is a PNG by its first bytes
    And each is within capabilities.images.maxBytesPerImage of every provider that takes images
    And together they are within capabilities.images.maxBytesPerRequest of every such provider
    And there are no more of them than the smallest maxCount

  Scenario: The sample images are reproducible
    Given scripts/sample-images.ts, which draws the pictures without any dependency
    When the tests render the pictures with the same function the script uses
    Then the decoded pixels equal those of the committed files
    # The compressed bytes may differ between Node versions, because each links its own zlib.

  Scenario: Every example file is a valid request
    Given every JSON file in src/decision/examples/
    When the tests run
    Then each one validates against every provider's capabilities with validateDecisionRequest
    And the film examples equal the previous noulExample, choiceExample, and scoreExample

  # --- Accessibility ---------------------------------------------------------------------------------------------------

  Scenario: Both load buttons are reachable and labelled
    Given keyboard-only use, with a provider that takes images selected
    When the person tabs through a panel
    Then "Load film example" and "Load image example" are reached before the view switch
    And each sits in a group labelled "Examples for <Panel name>"
    And after loading, focus is on the first field of the loaded request

  Scenario: Nothing is announced on initial render
    Given a fresh page load
    When the panels render
    Then every panel status line and every image control status line is empty

  # --- Manual live check (the coordinator runs it) -------------------------------------------------------------------

  Scenario: The image example runs on both image providers
    Given vp dev is running with real SubQ and OpenAI keys
    And SubQ Snap is selected
    When "Load image example" is pressed in each of the three panels, and each panel is run
    Then every answer is about the sample pictures, which the model can only tell apart by their pixels: image 1 is red, image 2 is a circle, image 3 has straight edges only, and image 4 is the cluttered one
    And the same holds after switching to OpenAI Decisions, loading the image example again, and running the three panels
    And the wire view shows four image placeholders for each run
