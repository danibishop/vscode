/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as nls from 'vs/nls';
import {isPromiseCanceledError} from 'vs/base/common/errors';
import {KeyMod, KeyCode} from 'vs/base/common/keyCodes';
import Severity from 'vs/base/common/severity';
import {TPromise} from 'vs/base/common/winjs.base';
import {IEditorService} from 'vs/platform/editor/common/editor';
import {IEventService} from 'vs/platform/event/common/event';
import {KbCtxKey, IKeybindingContextKey, IKeybindingService, KbExpr} from 'vs/platform/keybinding/common/keybinding';
import {IMessageService} from 'vs/platform/message/common/message';
import {IProgressService} from 'vs/platform/progress/common/progress';
import {ServicesAccessor, EditorAction, EditorCommand, CommonEditorRegistry} from 'vs/editor/common/editorCommonExtensions';
import {EditorBrowserRegistry} from 'vs/editor/browser/editorBrowserExtensions';
import {IRange, ICommonCodeEditor, EditorContextKeys, ModeContextKeys, IEditorContribution} from 'vs/editor/common/editorCommon';
import {BulkEdit, createBulkEdit} from 'vs/editor/common/services/bulkEdit';
import {RenameProviderRegistry} from 'vs/editor/common/modes';
import {ICodeEditor} from 'vs/editor/browser/editorBrowser';
import {rename} from '../common/rename';
import RenameInputField from './renameInputField';

// ---  register actions and commands

const CONTEXT_RENAME_INPUT_VISIBLE = new KbCtxKey<boolean>('renameInputVisible', false);

class RenameController implements IEditorContribution {

	private static ID = 'editor.contrib.renameController';

	public static get(editor:ICommonCodeEditor): RenameController {
		return <RenameController>editor.getContribution(RenameController.ID);
	}

	private _renameInputField: RenameInputField;
	private _renameInputVisible: IKeybindingContextKey<boolean>;

	constructor(
		private editor:ICodeEditor,
		@IMessageService private _messageService: IMessageService,
		@IEventService private _eventService: IEventService,
		@IEditorService private _editorService: IEditorService,
		@IProgressService private _progressService: IProgressService,
		@IKeybindingService keybindingService: IKeybindingService
	) {
		this._renameInputField = new RenameInputField(editor);
		this._renameInputVisible = CONTEXT_RENAME_INPUT_VISIBLE.bindTo(keybindingService);
	}

	public dispose(): void {
		this._renameInputField.dispose();
	}

	public getId(): string {
		return RenameController.ID;
	}

	public run(): TPromise<void> {

		const selection = this.editor.getSelection(),
			word = this.editor.getModel().getWordAtPosition(selection.getStartPosition());

		if (!word) {
			return;
		}

		let lineNumber = selection.startLineNumber,
			selectionStart = 0,
			selectionEnd = word.word.length,
			wordRange: IRange;

		wordRange = {
			startLineNumber: lineNumber,
			startColumn: word.startColumn,
			endLineNumber: lineNumber,
			endColumn: word.endColumn
		};

		if (!selection.isEmpty() && selection.startLineNumber === selection.endLineNumber) {
			selectionStart = Math.max(0, selection.startColumn - word.startColumn);
			selectionEnd = Math.min(word.endColumn, selection.endColumn) - word.startColumn;
		}

		this._renameInputVisible.set(true);
		return this._renameInputField.getInput(wordRange, word.word, selectionStart, selectionEnd).then(newName => {
			this._renameInputVisible.reset();
			this.editor.focus();

			const renameOperation = this._prepareRename(newName).then(edit => {

				return edit.finish().then(selection => {
					if (selection) {
						this.editor.setSelection(selection);
					}
				});

			}, err => {
				if (typeof err === 'string') {
					this._messageService.show(Severity.Info, err);
				} else {
					this._messageService.show(Severity.Error, nls.localize('rename.failed', "Sorry, rename failed to execute."));
					return TPromise.wrapError(err);
				}
			});

			this._progressService.showWhile(renameOperation, 250);
			return renameOperation;

		}, err => {
			this._renameInputVisible.reset();
			this.editor.focus();

			if (!isPromiseCanceledError(err)) {
				return TPromise.wrapError(err);
			}
		});
	}

	public acceptRenameInput(): void {
		this._renameInputField.acceptInput();
	}

	public cancelRenameInput(): void {
		this._renameInputField.cancelInput();
	}

	private _prepareRename(newName: string): TPromise<BulkEdit> {

		// start recording of file changes so that we can figure out if a file that
		// is to be renamed conflicts with another (concurrent) modification
		let edit = createBulkEdit(this._eventService, this._editorService, <ICodeEditor>this.editor);

		return rename(this.editor.getModel(), this.editor.getPosition(), newName).then(result => {
			if (result.rejectReason) {
				return TPromise.wrapError(result.rejectReason);
			}
			edit.add(result.edits);
			return edit;
		});
	}
}

// ---- action implementation

export class RenameAction extends EditorAction {

	constructor() {
		super(
			'editor.action.rename',
			nls.localize('rename.label', "Rename Symbol"),
			'Rename Symbol',
			true
		);

		this.kbOpts = {
			kbExpr: EditorContextKeys.TextFocus,
			primary: KeyCode.F2
		};

		this.menuOpts = {
			group: '1_modification',
			order: 1.1,
			kbExpr: KbExpr.and(ModeContextKeys.hasRenameProvider, EditorContextKeys.Writable)
		};
	}

	public supported(accessor:ServicesAccessor, editor:ICommonCodeEditor): boolean {
		if (!super.supported(accessor, editor)) {
			return false;
		}
		return RenameProviderRegistry.has(editor.getModel()) && !editor.getModel().hasEditableRange();
	}

	public enabled(accessor:ServicesAccessor, editor:ICommonCodeEditor): boolean {
		if (!super.enabled(accessor, editor)) {
			return false;
		}
		return RenameProviderRegistry.has(editor.getModel());
	}

	public run(accessor:ServicesAccessor, editor:ICommonCodeEditor): TPromise<void> {
		return RenameController.get(editor).run();
	}
}

EditorBrowserRegistry.registerEditorContribution(RenameController);

const RenameCommand = EditorCommand.bindToContribution<RenameController>(
	RenameController.get, {
		weight: CommonEditorRegistry.commandWeight(99),
		kbExpr: KbExpr.and(EditorContextKeys.Focus, CONTEXT_RENAME_INPUT_VISIBLE)
	}
);

CommonEditorRegistry.registerEditorAction(new RenameAction());

CommonEditorRegistry.registerEditorCommand2(new RenameCommand(
	'acceptRenameInput',
	x => x.acceptRenameInput(),
	{
		primary: KeyCode.Enter
	}
));

CommonEditorRegistry.registerEditorCommand2(new RenameCommand(
	'cancelRenameInput',
	x => x.cancelRenameInput(),
	{
		primary: KeyCode.Escape,
		secondary: [KeyMod.Shift | KeyCode.Escape]
	}
));
