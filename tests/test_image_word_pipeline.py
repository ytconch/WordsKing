import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from scripts import image_word_pipeline as pipeline


def make_row(word="accelerate", meaning="加速", tense="v."):
    return {
        "eng": word,
        "kk": "",
        "tense": tense,
        "ch": [[meaning]],
        "analysis": "此字依其語法身份、可靠構詞與歷史來源形成現代常見語義。",
        "definition": "1. a common modern meaning",
        "example": [
            {
                "eng": f"This sentence uses {word} naturally.",
                "ch": f"這個句子自然使用 {word}。"
            }
        ]
    }


class PromptContractTests(unittest.TestCase):
    def test_every_active_prompt_contains_one_shared_contract(self):
        row = make_row()
        prompts = [
            pipeline.build_prompt("accelerate"),
            pipeline.build_words_only_prompt(["accelerate"]),
            pipeline.build_second_pass_review_prompt_from_ocr("accelerate", [row]),
            pipeline.build_second_pass_review_prompt_from_words(["accelerate"], [row]),
            pipeline.build_third_pass_review_prompt_from_ocr("accelerate", [row], [row]),
            pipeline.build_third_pass_review_prompt_from_words(
                ["accelerate"],
                [row],
                [row]
            )
        ]

        for prompt in prompts:
            self.assertEqual(prompt.count("# Output Contract"), 1)
            self.assertIn("# Positive Evidence Threshold", prompt)
            self.assertIn("# Morphology and Etymology Contract", prompt)
            self.assertNotIn("只要不能明確證明不存在", prompt)
            self.assertNotIn("只要答案可能是會", prompt)
            self.assertLess(len(prompt), 6000)

    def test_unrelated_problem_words_do_not_pollute_prompt(self):
        prompt = pipeline.build_words_only_prompt(["accelerate"])

        self.assertNotIn("scrap, charge, claim", prompt)
        self.assertNotIn("# Input-specific Conversion Audit", prompt)

    def test_targeted_conversion_audit_only_names_actual_input(self):
        prompt = pipeline.build_words_only_prompt(["scrap", "accelerate"])

        self.assertIn("# Input-specific Conversion Audit", prompt)
        self.assertIn("- scrap:", prompt)
        self.assertNotIn("- charge:", prompt)
        self.assertNotIn("- offering:", prompt)

    def test_etymology_contract_distinguishes_root_and_transmission(self):
        prompt = pipeline.build_words_only_prompt(["accelerate"])

        self.assertIn("詞根／詞幹", prompt)
        self.assertIn("完整拉丁詞形", prompt)
        self.assertIn("ad-", prompt)
        self.assertIn("ac-", prompt)
        self.assertIn("傳入媒介是可選資訊", prompt)
        self.assertIn("不可因英文字有拉丁上源，就預設它經法語傳入", prompt)
        self.assertIn("不可為迎合拉丁分析而虛構", prompt)

    def test_surface_form_policy_is_explicit(self):
        prompt = pipeline.build_words_only_prompt(["offering"])

        self.assertIn("eng 必須保留使用者輸入的表面詞形", prompt)
        self.assertIn("不可擅自改成未輸入的 lemma", prompt)
        self.assertIn("- offering:", prompt)

    def test_sense_partition_and_pronunciation_guards_are_explicit(self):
        prompt = pipeline.build_words_only_prompt(["accelerate"])

        self.assertIn("各群組必須互斥", prompt)
        self.assertIn("只是另一群的領域示例", prompt)
        self.assertIn("發生的來源語構詞階段", prompt)
        self.assertIn("非重讀母音弱化", prompt)
        self.assertIn("沒有把握時輸出空字串", prompt)


class GeneratedOutputValidatorTests(unittest.TestCase):
    def test_valid_rows_pass_and_normalize(self):
        row = make_row()

        pipeline.validate_generated_rows([row], expected_words=["accelerate"])
        normalized = pipeline.normalize_words([row])

        self.assertEqual(normalized[0]["ch"], [["加速"]])
        self.assertEqual(normalized[0]["example"][0]["eng"], row["example"][0]["eng"])

    def test_illegal_tense_is_rejected(self):
        row = make_row(tense="gerund")

        with self.assertRaises(pipeline.GeneratedOutputValidationError):
            pipeline.validate_generated_rows([row], expected_words=["accelerate"])

    def test_more_than_five_sense_groups_is_rejected(self):
        row = make_row()
        row["ch"] = [[str(index)] for index in range(6)]
        row["definition"] = "; ".join(
            f"{index}. definition" for index in range(1, 7)
        )
        row["example"] = [
            {"eng": f"Example {index}.", "ch": f"例句 {index}。"}
            for index in range(1, 7)
        ]

        with self.assertRaises(pipeline.GeneratedOutputValidationError):
            pipeline.validate_generated_rows([row], expected_words=["accelerate"])

    def test_definition_and_example_alignment_is_not_a_batch_killing_error(self):
        row = make_row()
        row["ch"] = [["加速"], ["促進"]]

        pipeline.validate_generated_rows([row], expected_words=["accelerate"])

    def test_duplicate_meaning_across_groups_is_rejected(self):
        row = make_row()
        row["ch"] = [["加速"], ["加速"]]
        row["definition"] = "1. to go faster; 2. to go faster"
        row["example"] = [
            {"eng": "The car accelerated.", "ch": "汽車加速了。"},
            {"eng": "The train accelerated.", "ch": "火車加速了。"}
        ]

        with self.assertRaises(pipeline.GeneratedOutputValidationError):
            pipeline.validate_generated_rows([row], expected_words=["accelerate"])

    def test_duplicate_row_key_is_rejected(self):
        row = make_row()

        with self.assertRaises(pipeline.GeneratedOutputValidationError):
            pipeline.validate_generated_rows([row, dict(row)])

    def test_word_list_coverage_and_order_are_enforced(self):
        rows = [make_row("record"), make_row("charge")]

        with self.assertRaises(pipeline.GeneratedOutputValidationError):
            pipeline.validate_generated_rows(
                rows,
                expected_words=["charge", "record"]
            )

        with self.assertRaises(pipeline.GeneratedOutputValidationError):
            pipeline.validate_generated_rows(
                [make_row("record")],
                expected_words=["record", "charge"]
            )

    def test_parse_normalizes_harmless_model_variance(self):
        row = make_row(tense="noun")
        row["ch"] = [[str(index)] for index in range(1, 7)]
        row["extra"] = "ignored"
        response = SimpleNamespace(text=json.dumps([row], ensure_ascii=False))

        rows = pipeline.parse_and_validate_response(
            response,
            ["test-key"],
            expected_words=["accelerate"]
        )

        self.assertEqual(tuple(rows[0].keys()), pipeline.OUTPUT_FIELD_ORDER)
        self.assertEqual(rows[0]["tense"], "n.")
        self.assertEqual(len(rows[0]["ch"]), 5)
        self.assertNotIn("extra", rows[0])

    def test_parse_deduplicates_rows_and_restores_input_order(self):
        weaker_record = make_row("record", "紀錄", "n.")
        stronger_record = make_row("record", "紀錄", "n.")
        stronger_record["analysis"] += " More verified detail."
        response = SimpleNamespace(
            text=json.dumps(
                [
                    weaker_record,
                    make_row("charge", "收費", "n."),
                    stronger_record
                ],
                ensure_ascii=False
            )
        )

        rows = pipeline.parse_and_validate_response(
            response,
            ["test-key"],
            expected_words=["charge", "record"]
        )

        self.assertEqual([row["eng"] for row in rows], ["charge", "record"])
        self.assertEqual(rows[1]["analysis"], stronger_record["analysis"])

    def test_example_parser_accepts_single_object_and_common_aliases(self):
        self.assertEqual(
            pipeline.parse_example_items(
                {
                    "sentence": "The car accelerated.",
                    "translation": "汽車加速了。"
                }
            ),
            [{"eng": "The car accelerated.", "ch": "汽車加速了。"}]
        )
        self.assertEqual(
            pipeline.parse_example_items(
                {
                    "en": "Growth accelerated.",
                    "zh": "成長加速了。"
                }
            ),
            [{"eng": "Growth accelerated.", "ch": "成長加速了。"}]
        )

    def test_first_pass_can_continue_with_empty_examples(self):
        row = make_row()
        row["example"] = []
        response = SimpleNamespace(text=json.dumps([row], ensure_ascii=False))

        rows = pipeline.parse_and_validate_response(
            response,
            ["test-key"],
            expected_words=["accelerate"],
            allow_empty_examples=True
        )

        self.assertEqual(rows[0]["example"], [])

    def test_blank_tense_is_restored_from_unique_reference_row(self):
        row = make_row(tense="")
        response = SimpleNamespace(text=json.dumps([row], ensure_ascii=False))
        reference_items = pipeline.normalize_input_word_items(
            {
                "items": [
                    {
                        "eng": "accelerate",
                        "tense": "v.",
                        "existing": make_row(tense="v.")
                    }
                ]
            }
        )

        rows = pipeline.parse_and_validate_response(
            response,
            ["test-key"],
            expected_words=["accelerate"],
            allow_empty_tense=True,
            reference_items=reference_items
        )

        self.assertEqual(rows[0]["tense"], "v.")

    def test_missing_json_member_comma_is_repaired_locally(self):
        damaged = (
            '[{"eng":"record","kk":""'
            '"tense":"n.","ch":[["紀錄"]],'
            '"analysis":"analysis","definition":"1. record",'
            '"example":[{"eng":"Keep a record.","ch":"保留紀錄。"}]}]'
        )

        payload = pipeline.parse_json_payload_with_fallback(
            damaged,
            ["unused-key"]
        )

        self.assertEqual(payload[0]["tense"], "n.")


class ReviewFallbackTests(unittest.TestCase):
    def test_later_pass_can_restore_a_word_missing_from_first_pass(self):
        first_rows = [make_row("record", "紀錄", "n.")]
        completed_rows = [
            make_row("record", "紀錄", "n."),
            make_row("charge", "收費", "n.")
        ]
        responses = [
            SimpleNamespace(text=json.dumps(first_rows, ensure_ascii=False)),
            SimpleNamespace(text=json.dumps(completed_rows, ensure_ascii=False)),
            SimpleNamespace(text=json.dumps(completed_rows, ensure_ascii=False))
        ]

        with patch.object(
            pipeline,
            "call_gemini_with_retry",
            side_effect=responses
        ):
            rows = pipeline.generate_words_with_three_pass_review(
                "pass-one",
                lambda _first: "pass-two",
                lambda _first, _second: "pass-three",
                ["test-key"],
                input_words=["record", "charge"]
            )

        self.assertEqual([row["eng"] for row in rows], ["record", "charge"])

    def test_invalid_third_pass_falls_back_to_second_pass(self):
        first_row = make_row("record", "紀錄", "n.")
        second_row = make_row("record", "記錄", "n.")
        invalid_third = make_row("record", "錯誤", "gerund")
        responses = [
            SimpleNamespace(text=json.dumps([first_row], ensure_ascii=False)),
            SimpleNamespace(text=json.dumps([second_row], ensure_ascii=False)),
            SimpleNamespace(text=json.dumps([invalid_third], ensure_ascii=False))
        ]

        with patch.object(
            pipeline,
            "call_gemini_with_retry",
            side_effect=responses
        ):
            rows = pipeline.generate_words_with_three_pass_review(
                "pass-one",
                lambda _first: "pass-two",
                lambda _first, _second: "pass-three",
                ["test-key"],
                input_words=["record"]
            )

        self.assertEqual(rows[0]["ch"], [["記錄"]])
        self.assertEqual(rows[0]["tense"], "n.")

    def test_refresh_restores_all_existing_rows_for_fully_missing_word(self):
        input_items = pipeline.normalize_input_word_items(
            {
                "items": [
                    {
                        "eng": "charge",
                        "tense": "n.",
                        "existing": make_row("charge", "費用", "n.")
                    },
                    {
                        "eng": "charge",
                        "tense": "v.",
                        "existing": make_row("charge", "收費", "v.")
                    }
                ]
            }
        )

        rows, restored_words = pipeline.restore_fully_missing_words(
            [make_row("record", "紀錄", "n.")],
            input_items=input_items
        )

        self.assertEqual(restored_words, ["charge"])
        self.assertEqual(
            [row["tense"] for row in rows if row["eng"] == "charge"],
            ["n.", "v."]
        )

    def test_final_draft_restores_fully_missing_word_from_previous_pass(self):
        rows, restored_words = pipeline.restore_fully_missing_words(
            [make_row("record", "紀錄", "n.")],
            fallback_row_sets=[
                [
                    make_row("record", "紀錄", "n."),
                    make_row("charge", "收費", "v.")
                ]
            ]
        )

        self.assertEqual(restored_words, ["charge"])
        self.assertEqual(
            [(row["eng"], row["tense"]) for row in rows],
            [("record", "n."), ("charge", "v.")]
        )

    def test_refresh_uses_existing_example_when_all_ai_passes_leave_it_empty(self):
        empty_example_row = make_row("record", "紀錄", "n.")
        empty_example_row["example"] = []
        existing_row = make_row("record", "紀錄", "n.")
        input_items = pipeline.normalize_input_word_items(
            {
                "items": [
                    {
                        "eng": "record",
                        "tense": "n.",
                        "existing": existing_row
                    }
                ]
            }
        )
        responses = [
            SimpleNamespace(text=json.dumps([empty_example_row], ensure_ascii=False)),
            SimpleNamespace(text=json.dumps([empty_example_row], ensure_ascii=False)),
            SimpleNamespace(text=json.dumps([empty_example_row], ensure_ascii=False))
        ]

        with patch.object(
            pipeline,
            "call_gemini_with_retry",
            side_effect=responses
        ):
            rows = pipeline.generate_words_with_three_pass_review(
                "pass-one",
                lambda _first: "pass-two",
                lambda _first, _second: "pass-three",
                ["test-key"],
                input_words=["record"],
                input_items=input_items
            )

        self.assertEqual(rows[0]["example"], existing_row["example"])


class GeminiRetryTests(unittest.TestCase):
    def test_single_assigned_key_returns_429_to_job_coordinator_immediately(self):
        generate_content = Mock(side_effect=Exception("429 RESOURCE_EXHAUSTED"))
        client = SimpleNamespace(
            models=SimpleNamespace(generate_content=generate_content)
        )

        with patch.object(pipeline, "create_gemini_client", return_value=client):
            with self.assertRaises(Exception):
                pipeline.call_gemini_with_retry("prompt", ["key-1"], retries=15)

        self.assertEqual(generate_content.call_count, 1)

    def test_standalone_multi_key_mode_rotates_after_429(self):
        first_generate = Mock(side_effect=Exception("429 RESOURCE_EXHAUSTED"))
        expected_response = SimpleNamespace(text="[]")
        second_generate = Mock(return_value=expected_response)
        clients = [
            SimpleNamespace(models=SimpleNamespace(generate_content=first_generate)),
            SimpleNamespace(models=SimpleNamespace(generate_content=second_generate))
        ]

        with patch.object(pipeline, "create_gemini_client", side_effect=clients):
            response = pipeline.call_gemini_with_retry(
                "prompt",
                ["key-1", "key-2"],
                retries=2
            )

        self.assertIs(response, expected_response)
        self.assertEqual(first_generate.call_count, 1)
        self.assertEqual(second_generate.call_count, 1)


if __name__ == "__main__":
    unittest.main()
