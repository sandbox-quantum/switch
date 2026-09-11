"""Advisory checks on a template document.

The property that matters most here is what the linter *declines* to have an
opinion about. It runs against documents the registry is required to store in
shapes this server may not know, so a check that quietly encoded today's room
format would start refusing group templates the day they land.
"""

from __future__ import annotations

import pytest

from switch_core.template_lint import lint_template


def _codes(findings: list) -> set[str]:
    return {f.code for f in findings}


# The canonical example for the room-template surface, kept here rather than
# read from `examples/` because that file arrives with CHOO-2656 and this
# branch must not add a second copy of it. It exercises three things at once:
# a `kickoff:` block beside `room:`, `{$creator}` builtins, and a `multiline`
# param field — none of which the format module on this branch knows yet.
_CANONICAL_EXAMPLE = """\
params:
  task_name:
    type: string
    description: Short name for the task (used in the room name)
  coder_agent:
    type: string
    description: Agent that implements the task
  reviewer_agent:
    type: string
    description: Agent that reviews and drives the acceptance loop
  brief:
    type: string
    multiline: true
    description: The task brief (paste the full text)
room:
  name: "Switch work: {task_name}"
  description: "Workroom for {task_name} — coder/reviewer loop, human-gated."
  channel_type: channel_private
  agents: ["{coder_agent}", "{reviewer_agent}"]
  users: ["{$creator}"]
  instructions: |
    This room implements {task_name}. {coder_agent} owns the branch and
    commits. {reviewer_agent} reviews against the Acceptance section of the
    brief and pushes the coder in a loop until every item is met. Only
    {$creator}'s explicit confirmation stops the loop.

    Brief:
    {brief}
kickoff: |
  @{coder_agent} @{reviewer_agent} — kicking off {task_name}.

  @{coder_agent}: read the brief in the room instructions and start
  implementing. Post your plan here before your first commit.

  @{reviewer_agent}: drive the acceptance loop. Review every hand-off
  against the brief's Acceptance section and push back until every item is
  met, then ping {$creator} to confirm and close.
"""


class TestTheCanonicalExample:
    """The document the room-template surface is documented by.

    If the checker calls this wrong, the checker is wrong. It is the sharpest
    test of shape-agnosticism available, because it was written against a
    newer format module than this branch carries.
    """

    def test_it_raises_no_errors(self) -> None:
        result = lint_template(_CANONICAL_EXAMPLE)
        assert result.ok, [f.message for f in result.errors]

    def test_kickoff_is_not_called_an_unknown_key(self) -> None:
        result = lint_template(_CANONICAL_EXAMPLE)
        assert "unknown_top_level_key" not in _codes(result.warnings)

    def test_the_creator_builtin_is_not_called_an_undeclared_placeholder(self) -> None:
        """`{$creator}` is the server's to fill; a template must not declare it."""
        result = lint_template(_CANONICAL_EXAMPLE)
        assert "undeclared_placeholder" not in _codes(result.warnings)
        assert "unknown_builtin" not in _codes(result.warnings)

    def test_every_parameter_is_seen_as_used(self) -> None:
        """Two of them are only referenced from inside the kickoff block."""
        result = lint_template(_CANONICAL_EXAMPLE)
        assert "unused_param" not in _codes(result.warnings)

    def test_a_newer_param_field_is_a_warning_not_an_error(self) -> None:
        """`multiline` lands with CHOO-2656; this branch predates it.

        Reported so a typo is still visible, but not as an error — a document
        written for a newer Switch is the ordinary case for a registry, not a
        broken document.
        """
        result = lint_template(_CANONICAL_EXAMPLE)
        (warning,) = [w for w in result.warnings if w.code == "unknown_param_field"]
        assert warning.subject == "brief"
        assert "multiline" in warning.message


class TestWhatBarsTheDoor:
    """Which findings refuse an upload, and — more importantly — which do not.

    The blocking set is deliberately tiny and deliberately shape-independent.
    Every entry added to it is a document some future format cannot store, so
    the list itself is the thing to be sceptical of.
    """

    @pytest.mark.parametrize(
        "text",
        ["", "a: [unclosed\n", "- one\n- two\n", "just a bare string"],
        ids=["empty", "not-yaml", "a-list", "a-scalar"],
    )
    def test_a_document_no_consumer_could_read_is_blocked(self, text: str) -> None:
        assert lint_template(text).blocked

    @pytest.mark.parametrize(
        "text",
        [
            "params:\n  v:\n    type: enum\nroom:\n  name: '{v}'\n",
            "params:\n  owner:\nroom:\n  name: '{owner}'\n",
            "params:\n  owner:\n    type: nonsense\nroom:\n  name: '{owner}'\n",
            "params:\n  - a\n  - b\nroom:\n  name: r\n",
        ],
        ids=[
            "enum-without-choices",
            "bare-param",
            "unknown-type",
            "params-not-a-mapping",
        ],
    )
    def test_a_document_only_the_format_objects_to_is_not_blocked(
        self, text: str
    ) -> None:
        """These are errors, and still not this checker's call to make.

        The format moves and this checker has called a valid document invalid
        before — and Console's own parser accepts a bare param that this
        server refuses, so the two already disagree about one of these.
        """
        result = lint_template(text)
        assert result.errors, "expected the checker to object"
        assert not result.blocked

    def test_the_blocking_finding_says_it_blocks(self) -> None:
        """So a caller can show which one is the refusal."""
        (error,) = lint_template("a: [unclosed\n").errors
        assert error.blocking is True

    def test_a_document_it_merely_dislikes_says_it_does_not(self) -> None:
        (error,) = lint_template(
            "params:\n  v:\n    type: enum\nroom:\n  name: '{v}'\n"
        ).errors
        assert error.blocking is False


class TestBuiltins:
    def test_a_misspelled_builtin_is_caught(self) -> None:
        result = lint_template('room:\n  users: ["{$creatr}"]\n')
        (warning,) = [w for w in result.warnings if w.code == "unknown_builtin"]
        assert warning.subject == "$creatr"
        assert "$creator" in warning.message

    @pytest.mark.parametrize(
        "builtin", ["$creator", "$creator_email", "$date", "$timestamp"]
    )
    def test_each_known_builtin_passes(self, builtin: str) -> None:
        result = lint_template(f'room:\n  name: "{{{builtin}}}"\n')
        assert result.ok and result.warnings == []

    def test_a_builtin_is_never_reported_as_a_missing_parameter(self) -> None:
        result = lint_template('room:\n  users: ["{$creator}"]\n')
        assert result.warnings == []


class TestUnknownParamFields:
    def test_the_rest_of_the_spec_is_still_checked(self) -> None:
        """An unknown field must not buy a free pass on a real mistake."""
        result = lint_template(
            "params:\n"
            "  visibility:\n"
            "    type: enum\n"
            "    multiline: true\n"
            "room:\n"
            "  channel_type: '{visibility}'\n"
        )
        assert _codes(result.errors) == {"enum_without_choices"}
        assert _codes(result.warnings) == {"unknown_param_field"}

    def test_a_malformed_field_is_still_an_error_alongside_an_unknown_one(self) -> None:
        result = lint_template(
            "params:\n"
            "  owner:\n"
            "    type: nonsense\n"
            "    multiline: true\n"
            "room:\n"
            "  name: '{owner}'\n"
        )
        assert "invalid_param_spec" in _codes(result.errors)
        assert "unknown_param_field" in _codes(result.warnings)


class TestShapeAgnosticism:
    def test_a_room_template_is_clean(self) -> None:
        result = lint_template(
            "params:\n"
            "  owner:\n"
            "    type: string\n"
            "room:\n"
            '  name: "{owner} deploy"\n'
            "  description: d\n"
        )
        assert result.ok
        assert result.warnings == []

    def test_a_group_template_is_clean_too(self) -> None:
        """No `room:` key at all — the shape CHOO-2657 introduces.

        The linter must not have learned that a template is a room, or it
        starts rejecting valid documents the moment a second shape exists.
        """
        result = lint_template(
            "params:\n"
            "  owner:\n"
            "    type: string\n"
            "group:\n"
            '  name: "{owner} workstream"\n'
            "rooms:\n"
            "  - name: planning\n"
            "  - name: delivery\n"
        )
        assert result.ok
        assert result.warnings == []

    def test_a_shape_nobody_has_invented_yet_is_a_warning_not_an_error(self) -> None:
        result = lint_template("agent:\n  name: helper\n  model: sonnet\n")
        assert result.ok, "an unknown shape must still be storable"
        assert _codes(result.warnings) == {"unknown_top_level_key"}

    def test_a_document_with_no_recognised_key_is_still_only_warned_about(self) -> None:
        result = lint_template("whatever:\n  - 1\n  - 2\n")
        assert result.ok


class TestUnparseableInput:
    @pytest.mark.parametrize(
        "text,code",
        [
            ("", "empty"),
            ("   \n  \n", "empty"),
            ("# just a comment\n", "empty"),
            ("- one\n- two\n", "not_a_mapping"),
            ("just a bare string", "not_a_mapping"),
            ("42", "not_a_mapping"),
            ("room:\n  name: x\n bad-indent: y\n", "invalid_yaml"),
            ("a: [unclosed\n", "invalid_yaml"),
        ],
        ids=[
            "empty",
            "whitespace",
            "comment-only",
            "list",
            "scalar",
            "number",
            "bad-indent",
            "unclosed",
        ],
    )
    def test_it_is_reported_as_an_error(self, text: str, code: str) -> None:
        result = lint_template(text)
        assert not result.ok
        assert code in _codes(result.errors)

    def test_a_syntax_error_says_where(self) -> None:
        """A line number is most of the value when you are staring at an editor."""
        result = lint_template("room:\n  name: x\n bad: y\n")
        (error,) = result.errors
        assert "line" in error.message and "column" in error.message


class TestParamsBlock:
    def test_a_params_block_that_is_not_a_mapping_is_an_error(self) -> None:
        result = lint_template("params:\n  - owner\nroom:\n  name: x\n")
        assert _codes(result.errors) == {"params_not_a_mapping"}

    def test_a_bare_param_with_no_spec_is_an_error(self) -> None:
        """Provisioning refuses it, so the form should say so first."""
        result = lint_template("params:\n  owner:\nroom:\n  name: '{owner}'\n")
        assert _codes(result.errors) == {"param_has_no_spec"}

    @pytest.mark.parametrize(
        "spec",
        [
            "type: colour",
            "type: [not, a, type]",
            "enum: not-a-list",
        ],
        ids=["unknown-type", "type-is-a-list", "enum-is-not-a-list"],
    )
    def test_a_spec_provisioning_would_reject_is_an_error(self, spec: str) -> None:
        result = lint_template(
            f"params:\n  owner:\n    {spec}\nroom:\n  name: '{{owner}}'\n"
        )
        assert not result.ok
        assert "invalid_param_spec" in _codes(result.errors)

    def test_an_enum_with_no_choices_is_an_error(self) -> None:
        """Well-formed as a spec, and still unusable.

        `ParamSpec` allows an enum with no `enum:` list, so this only fails
        when somebody tries to resolve the parameter — long after, and far
        from, the mistake.
        """
        result = lint_template(
            "params:\n  visibility:\n    type: enum\n"
            "room:\n  channel_type: '{visibility}'\n"
        )
        assert _codes(result.errors) == {"enum_without_choices"}

    def test_a_default_outside_the_choices_is_an_error(self) -> None:
        result = lint_template(
            "params:\n"
            "  visibility:\n"
            "    type: enum\n"
            "    enum: [channel_public, channel_private]\n"
            "    default: secret\n"
            "room:\n"
            "  channel_type: '{visibility}'\n"
        )
        (error,) = result.errors
        assert error.code == "default_not_in_enum"
        assert "secret" in error.message and "channel_public" in error.message

    def test_the_error_names_the_parameter(self) -> None:
        result = lint_template(
            "params:\n  first:\n    type: string\n"
            "  second:\n    type: nonsense\n"
            "room:\n  name: '{first}{second}'\n"
        )
        (error,) = result.errors
        assert error.subject == "second"

    def test_a_valid_enum_param_is_clean(self) -> None:
        result = lint_template(
            "params:\n"
            "  visibility:\n"
            "    type: enum\n"
            "    enum: [channel_public, channel_private]\n"
            "    default: channel_private\n"
            "room:\n"
            "  channel_type: '{visibility}'\n"
        )
        assert result.ok and result.warnings == []


class TestPlaceholders:
    def test_a_placeholder_nothing_declares_is_warned_about(self) -> None:
        """The typo that otherwise ships silently.

        An undeclared placeholder is not an error anywhere — interpolation
        leaves it in the document verbatim — so the room ends up named
        literally "{ownr} deploy" and nothing ever said so.
        """
        result = lint_template(
            "params:\n  owner:\n    type: string\nroom:\n  name: '{ownr} deploy'\n"
        )
        assert result.ok
        codes = _codes(result.warnings)
        assert "undeclared_placeholder" in codes
        assert "unused_param" in codes
        assert {w.subject for w in result.warnings} == {"ownr", "owner"}

    def test_a_declared_param_nobody_uses_is_warned_about(self) -> None:
        result = lint_template(
            "params:\n  unused:\n    type: string\nroom:\n  name: fixed\n"
        )
        assert _codes(result.warnings) == {"unused_param"}

    def test_placeholders_are_found_at_any_depth(self) -> None:
        result = lint_template(
            "params:\n"
            "  owner:\n    type: string\n"
            "  repo:\n    type: string\n"
            "  agent:\n    type: string\n"
            "room:\n"
            "  name: fixed\n"
            "  agents: ['{agent}']\n"
            "  docs:\n"
            "    - name: readme\n"
            "      content: |\n"
            "        {owner} owns {repo}\n"
        )
        assert result.warnings == [], "every declared param is used somewhere"

    def test_a_placeholder_in_the_params_block_does_not_count_as_use(self) -> None:
        """`params:` declares placeholders; it does not consume them."""
        result = lint_template(
            "params:\n"
            "  owner:\n"
            "    type: string\n"
            "    description: 'the {owner} of the room'\n"
            "room:\n"
            "  name: fixed\n"
        )
        assert _codes(result.warnings) == {"unused_param"}

    def test_a_brace_that_is_not_a_placeholder_is_ignored(self) -> None:
        result = lint_template("room:\n  name: 'a {} b {1} c'\n")
        assert result.ok and result.warnings == []


class TestItNeverBlocksAnUpload:
    def test_even_the_worst_document_only_reports(self) -> None:
        """The registry stores what it is given; this only describes it."""
        result = lint_template("a: [unclosed\n")
        assert not result.ok
        assert isinstance(result.errors, list)
