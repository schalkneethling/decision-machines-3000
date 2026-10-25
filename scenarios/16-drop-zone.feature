Feature: A dynamic, accessible image drop zone that follows the selected provider

  Background:
    Given each panel form has an "Images" control, built by src/ui/attachments.ts into the panel's .attachments container
    And every limit the control shows or checks comes from the selected provider's capabilities.images as GET /api/providers serves it:
      | provider | maxCount | maxBytesPerImage | maxBytesPerRequest | mediaTypes                        |
      | typesafe | (false: text only)                                                                           |
      | subq     | 4        | 64 KiB           | 64 KiB             | image/png, image/jpeg, image/webp |
      | openai   | 8        | 64 KiB           | 64 KiB             | image/png, image/jpeg, image/webp |
    # The issue body's acceptance criteria name a "1 MB PNG" and OpenAI caps of "4 MiB each and 8 MiB in total". Its comments
    # replaced those: the owner first chose 2 MiB (issue #15), then a CPU measurement on Cloudflare's Free plan lowered both
    # caps to 64 KiB (65,536 bytes) per image and per request (PR #53). The scenarios below use the real caps, and the
    # client never holds a cap of its own: it reads maxCount, maxBytesPerImage, maxBytesPerRequest, and mediaTypes from the
    # provider summary, so a change in src/providers/catalog.ts reaches the UI without a second edit.
    # With caps this small most photos are over the limit, so the refusal for an oversized image is the common path.
    And the browser sends image bytes as they are: it never base64-encodes anything (the Worker does that once, issue #15)
    And the control's status line (role="status") announces only changes the user caused, and nothing on initial render

  # --- Markup and accessibility -------------------------------------------------------------------------------------

  Scenario: The control is a fieldset with a legend, a visible file-input button, and linked instructions
    Given SubQ Snap is selected
    When the panel's image control is inspected
    Then it is a <fieldset> whose first child is <legend>Images</legend>
    And it has no hidden attribute
    And it holds a visible <input type="file" multiple> whose accept attribute is "image/png,image/jpeg,image/webp"
    And the input's aria-describedby names the instructions and the capability line, both of which are in the fieldset
    And the fieldset's own aria-describedby points at the privacy note (MDN: fieldset has the implicit role "group")

  Scenario: The control leaves the accessibility tree for a text-only provider
    Given TypeSafe Jev is selected
    When the panel renders
    Then the fieldset has the hidden attribute
    And nothing is announced

  Scenario: The control follows a provider change between two image providers
    Given OpenAI Decisions is selected and the capability line says up to 8 images
    When the provider changes to SubQ Snap
    Then the accept attribute, the maximum count, and the size limits in the capability line match SubQ Snap
    And the provider status line (#provider-status, the page's single role="status" for provider changes) announces
      "Provider set to SubQ Snap. Image input available: up to 4 PNG, JPEG, or WebP images, 64 KB in total."
    # The three panels each have an image control. Announcing the same capability from all three status lines at once
    # would read the sentence three times, so the generic effect of a provider change is announced once, by the provider
    # status line that already announced "Images allowed, up to 4." before this issue. Each panel's own status line
    # announces only what concerns that panel's images: kept, marked, or fitting again.

  Scenario: The capability line states the caps and whose they are
    Given OpenAI Decisions is selected
    When the capability line renders
    Then it reads "OpenAI Decisions takes up to 8 images, 64 KB in total: PNG, JPEG, or WebP. These are this instance's limits, not the provider's."
    # Rewritten from the issue body, which named 4 MiB and 8 MiB. The sentence is built from the capabilities, so the
    # numbers follow the catalog. "Not the provider's" is said for every image provider, because the byte caps are the
    # project's for SubQ Snap too (SubQ documents 4 MiB and 8 MiB).

  Scenario: Thumbnails and Remove buttons are named by the file
    Given an attached image named "poster.png"
    When its list item renders
    Then its <img> alt is "poster.png"
    And its Remove button's accessible name is "Remove poster.png"
    And the item shows "image/png", the size as the wire view writes it ("12 KB"), and the pixel dimensions ("64 × 48")

  Scenario: Keyboard-only use reaches everything
    Given two attached images
    When the user tabs through the control
    Then the file-input button and each Remove button are focusable and labelled
    And the instructions are read with the input through aria-describedby

  Scenario: The privacy note is visible under the control
    Given an image provider is selected
    Then a note under the control says that images go from the browser to this instance's Worker and then to the chosen provider, that the Worker does not store them, and that the user should not upload images they are not allowed to share

  # --- Attaching ---------------------------------------------------------------------------------------------------

  Scenario: Choosing a file through the input attaches it
    Given SubQ Snap is selected
    When a 12 KiB PNG of 64 by 48 pixels is chosen via the file input
    Then a thumbnail (an object URL), "image/png", "12 KB", and "64 × 48" appear in the list
    And the status says "Image 1 added: poster.png, 12 KB."
    And the file input is cleared, so the same file can be chosen again later
    # Rewritten from "a 1 MB PNG ... 1.0 MB", which the 64 KiB cap makes impossible to attach.

  Scenario: A photo over the per-image cap is refused with a sentence that reads well
    Given SubQ Snap is selected
    When a 3.2 MB JPEG is chosen
    Then it is not attached, nothing is read beyond its first bytes, and no object URL is created
    And the status says "holiday.jpg was not added: it is 3.2 MB, over this instance's limit of 64 KB per image."
    # The common path at 64 KiB. Issue #25 will shrink the picture at the transform point instead of refusing it.

  Scenario: Images that together pass the per-request cap are refused
    Given OpenAI Decisions is selected with a 40 KiB image attached
    When a 30 KiB image is chosen
    Then it is refused and the status names the 64 KB per-request limit and the total the two would make

  Scenario: A fifth image on SubQ Snap is refused before anything is read
    Given SubQ Snap is selected with four images attached
    When a fifth is dropped
    Then it is refused, the status says "fifth.png was not added: SubQ Snap takes at most 4 images per request, and 4 are attached.", and no bytes are read

  Scenario: The media type comes from the bytes, not the name or the declared type
    Given a file named "photo.png" declared as image/png whose bytes are JPEG
    When it is attached
    Then the list shows "image/jpeg"
    And the File appended to the form declares type "image/jpeg" (the Worker detects the type again and is authoritative)

  Scenario: Bytes of no accepted format are refused
    Given a file whose bytes are GIF, or a text file
    When it is attached
    Then it is refused and the status says it is not a PNG, JPEG, or WebP image, judging by its first bytes

  Scenario: Pixel dimensions are read from the header, not by decoding
    Given a PNG, a JPEG whose frame header follows an APP0 segment, and a WebP in each of its VP8, VP8L, and VP8X layouts
    When each is attached
    Then its width and height are shown
    And a file whose header the parser does not understand shows "size unknown" and is still attached

  Scenario: A paste on the panel form attaches the image
    Given SubQ Snap is selected
    When a paste event with an image/png file item fires on the panel form
    Then the image is attached
    And a pasted Blob with no name is attached as "pasted-image-1.png", using the extension of its detected type, never "blob"

  Scenario: A paste while a text-only provider is selected is refused, not attached silently
    Given TypeSafe Jev is selected
    When a paste event with an image file item fires on the panel form
    Then nothing is attached and the status says "image.png was not added: TypeSafe Jev is text only."

  Scenario: Dropping files on the fieldset attaches them
    Given SubQ Snap is selected
    When files are dropped on the fieldset
    Then dragover was cancelled (preventDefault) so the drop could happen, the drop's default is prevented, and the images are attached
    # MDN, File drag and drop: the drop zone must cancel dragover for drop to fire; files come from dataTransfer.items via getAsFile().

  Scenario: The transform point for issue #25
    Given createAttachments is given a transform function
    When a file arrives (from the input, a drop, or a paste) and passes the count check
    Then the transform receives the file with its detected media type and the provider's image limits, before any size check
    And whatever File it returns is detected and measured again, then checked against the limits
    And the default transform returns the file unchanged
    # This is the one documented point where #25 shrinks an oversized image; this issue implements no shrinking.
    # A design note for the owner: the owner's comment on #16 asked only that the over-limit marking stay "easy to
    # attach a button to". At a 64 KiB cap an oversized file is refused in the pipeline and never listed, so there is
    # no list item to put a button on; the hook above is where #25's automatic shrinking (its latest comment) fits
    # instead. If a per-image button is wanted after all, #25 would have to list refused files first.

  Scenario: A file that cannot be read is reported, and the rest of the selection still goes on
    Given three files are chosen and the second was moved or changed on disk since
    When the browser cannot read it (Chrome throws NotReadableError)
    Then the status says "gone.png was not added: it could not be read." between the two added images
    And the third file is still attached

  Scenario: A file a few hundred bytes over the cap is named by its exact byte count
    Given SubQ Snap is selected
    When a 65,800-byte PNG is chosen
    Then the status says "edge.png was not added: it is 65,800 bytes, over this instance's limit of 64 KB per image."
    # "64 KB, over the limit of 64 KB" would contradict itself, and this window is where #25's shrinking will land files.

  # --- Removing ----------------------------------------------------------------------------------------------------

  Scenario: Removing an image revokes its object URL
    Given an attached image
    When its Remove button is pressed
    Then the list item disappears and URL.revokeObjectURL is called with its preview URL
    And the status says "Image removed: poster.png. 1 image remains."
    And focus moves to the next Remove button, or to the file input when none is left

  # --- Sending -----------------------------------------------------------------------------------------------------

  Scenario: With images attached, Run posts multipart/form-data built with FormData
    Given SubQ Snap is selected and two images are attached
    When Run is pressed
    Then fetch is called with a FormData body
    And the app sets no Content-Type header (MDN: a hand-set header drops the boundary)
    And new Request(url, { method: "POST", body }) gives a Content-Type that starts with "multipart/form-data; boundary="
    And form.get("request") is a string equal to the textarea text in the JSON view, or the serialised tree request
    And form.getAll("image") holds one entry per image, in order, each a File with the original bytes
    And no part contains base64

  Scenario: Parts are added with append, never set, and every image part has a filename
    Given three images, one of them a pasted Blob
    When the form is built
    Then getAll("image") returns three entries and get("request") returns the request text
    And the pasted image's part filename is "pasted-image-1.png" and never "blob"

  Scenario: With no images, Run posts application/json as before
    Given no images are attached
    When Run is pressed
    Then the body is the textarea text (JSON view) or the serialised request (tree view) and Content-Type is application/json

  Scenario: The JSON view hint says how images travel
    Given two images are attached and the JSON view is open
    Then the hint under the textarea says "2 images attached. They are sent as image parts beside this JSON, not inside it."
    And the sentence disappears when the last image is removed

  # --- Provider changes with images attached ------------------------------------------------------------------------

  Scenario: Switching to a text-only provider keeps the images and says so
    Given two images are attached on SubQ Snap
    When the provider changes to TypeSafe Jev
    Then the fieldset is hidden, the two images stay in the panel's state
    And a visible notice in the panel says "TypeSafe Jev is text only. Your 2 images are kept and will not be sent."
    And the panel's status says "TypeSafe Jev is text only; your 2 images are kept and will not be sent"

  Scenario: Running on the text-only provider sends JSON and says what was left out
    Given that state
    When Run is pressed
    Then the request is application/json with no image parts
    And the result sentence ends "Sent without the 2 attached images."

  Scenario: Switching back to an image provider shows the images again
    Given that state
    When the provider changes back to SubQ Snap
    Then the fieldset is shown with both thumbnails still attached, the notice is empty, and the status says "Image input available again; your 2 images will be sent."

  Scenario: A lower limit marks the excess and blocks Run until it is removed
    Given eight images are attached on OpenAI Decisions
    When the provider changes to SubQ Snap (limit 4)
    Then images 5 to 8 are marked "Over the limit" in their list items
    And the panel's Run button is disabled and the notice says "4 images are over the limits of SubQ Snap: up to 4 images, 64 KB in total. Remove the 4 marked images to run."
    And the status announces the same
    And after the four are removed, Run is enabled, the notice is empty, and the removal that cleared the block announces
      "Image removed: 5.png. 4 images remain. Your 4 images fit the limits of SubQ Snap."
    # The marking is by the images that fit so far, the per-image cap, and the running total, so it also covers a
    # provider whose byte caps are lower. A new image is judged against the images that will be sent, not the marked ones.

  # --- Manual checks in Chrome (the coordinator runs these; they need vp dev, which needs 1Password) ---------------

  Scenario: Manual, the live round trip
    Given "vp dev --port 5199 --strictPort" is running with SUBQ_API_KEY set, and the page is open in Chrome
    And two PNG or JPEG files under 64 KiB are at hand (for example, "sips -Z 200 photo.jpg --out small.jpg" makes one)
    When SubQ Snap is chosen and the two files are chosen through the Noul panel's "Choose images" button
    Then two thumbnails appear with type, size, and dimensions, and the panel status says "Image 1 added …" then "Image 2 added …"
    When Run is pressed
    Then the Network panel shows a request to /api/decide/subq with Content-Type "multipart/form-data; boundary=…" set by Chrome
    And the readout answers, and the "Sent to SubQ Snap" wire block shows "<image 1: image/png, 12 KB>" placeholders, not base64

  Scenario: Manual, a phone photo
    When a photo of several megabytes is dropped on the fieldset
    Then it is refused at once, the status reads "… was not added: it is 3.2 MB, over this instance's limit of 64 KB per image.", and no thumbnail appears

  Scenario: Manual, paste
    When an image is copied (for example from a screenshot) and pasted while focus is in the panel
    Then it is attached as "pasted-image-1.png" or with the clipboard's own name

  Scenario: Manual, provider change
    Given two images are attached
    When TypeSafe Jev is chosen
    Then the fieldset disappears, the notice says the images are kept and will not be sent, and Run answers with "Sent without the 2 attached images."
    When SubQ Snap is chosen again
    Then the two thumbnails are back

  Scenario: Manual, with a screen reader (VoiceOver in Chrome)
    When the provider changes
    Then the capability sentence is announced once, not three times
    When an image is added, removed, or refused
    Then the panel's status announces it, and nothing is announced on page load
